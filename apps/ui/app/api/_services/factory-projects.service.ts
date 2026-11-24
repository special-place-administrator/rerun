import 'server-only'

import { createHash } from 'node:crypto'
import {
    FACTORY_REPO_PATTERN,
    factoryProjectDroppedSchema,
    factoryProjectLimitsSchema,
    isSafeFactoryRepo,
    parseGithubRepoLink,
    type FactoryProjectDropped,
    type FactoryProbeCode,
    type FactoryProjectErrorCode,
    type FactoryProjectItem,
    type FactoryProjectLimits,
    type FactoryProjects,
    type FactoryProjectSource,
    type FactoryProjectState,
} from '@moldwright/contracts'
import type { Actor } from '@/app/api/_auth/access'
import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { AuthorizationError } from '@/app/api/_auth/errors'
import type { Database } from '@/app/api/database.types'
import { getFactorySnapshot } from '@/lib/factory/snapshot-store'
import { askProjectCheck, clearProjectAsk, currentProjectAsk, factoryStamp, takeProjectAskAnswer, wantFactoryRepos, type ProjectAskAnswer } from '@/lib/factory/project-asks'
import { AppError } from '@/lib/i18n/action-error'
import { removePrivateFiles, uploadPrivateFile } from '@/lib/storage/private'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

type ProjectInsert = Database['public']['Tables']['factory_projects']['Insert']
type ProjectUpdate = Database['public']['Tables']['factory_projects']['Update']

const FACTORY_PROJECT_COLUMNS = ['id', 'name', 'source', 'repo', 'state', 'error_code', 'progress_done', 'progress_total', 'active', 'activated_at', 'created_at', 'updated_at', 'dropped'] as const
export type FactoryProject = {
    id: number; name: string; source: FactoryProjectSource; repo: string | null; state: FactoryProjectState; error_code: FactoryProjectErrorCode | null
    progress_done: number | null; progress_total: number | null; active: boolean; activated_at: string | null; created_at: string; updated_at: string
    dropped: FactoryProjectDropped
}
export type GithubAddOutcome = { project: FactoryProject; existed: boolean }
export type UploadRefusal = 'quota_unset' | 'quota_exceeded' | 'length_required' | 'upload_too_large' | 'unknown'
export type UploadOutcome = { project: FactoryProject } | { code: UploadRefusal }
export type FactoryReadyLine = FactoryProjects['ready'][number]['lines'][number]

export type PathOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; code: FactoryProbeCode | 'unknown' } | { state: 'added'; project: FactoryProject }
export type SelectOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; lines: FactoryReadyLine[] } | { state: 'selected' }

const CHECK_GIVES_UP_MS = 10 * 60_000
const MAX_PATH = 4096
const UNIQUE_VIOLATION = '23505'
const ITEMS_MAX = 1000
const QUEUE_MAX = 20
const QUEUE_STATES: FactoryProjectState[] = ['queued', 'unpacking', 'cloning']
const PROGRESS_STATES: readonly FactoryProjectState[] = ['cloning', 'uploading', 'unpacking']
const FACTORY_MOVES: Record<FactoryProjectSource, Partial<Record<FactoryProjectState, readonly FactoryProjectState[]>>> = {
    github: {
        queued: ['cloning', 'ready', 'failed'],
        cloning: ['cloning', 'ready', 'failed'],
        ready: ['ready', 'failed'],
        failed: ['failed'],
    },
    upload: {
        queued: ['unpacking', 'failed'],
        unpacking: ['unpacking', 'cloning', 'failed'],
        cloning: ['cloning', 'ready', 'failed'],
        ready: ['ready', 'failed'],
        failed: ['failed'],
    },
}
const UPLOAD_BUCKET = 'factory-uploads'
const UPLOAD_NAME_MAX = 100
const UPLOAD_NAME_DEFAULT = 'Uploaded folder'
const MB = 1024 * 1024
const uploadPath = (workspaceId: number, id: number) => `${workspaceId}/${id}.tar`

export async function isFactoryOwner(workspaceId: number, userId: string): Promise<boolean> {
    if ((await workspaceFounderUserId(workspaceId)) !== userId) return false
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'workspace_members', ['role'] as const, { workspace_id: workspaceId, user_id: userId })
    return data?.role === 'admin'
}

export async function isFactoryReporter(actor: Actor): Promise<boolean> {
    return actor.kind === 'workspace' || (actor.kind === 'user' && (await workspaceFounderUserId(actor.workspaceId)) === actor.userId)
}

export async function assertFactoryOwner(workspaceId: number, userId: string): Promise<void> {
    if (!(await isFactoryOwner(workspaceId, userId))) throw new AuthorizationError('factoryOwnerOnly')
}

const projectsOf = (workspaceId: number): FactoryProjects | undefined => getFactorySnapshot(workspaceId)?.snapshot.projects

async function projectRow(workspaceId: number, id: number): Promise<FactoryProject> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'factory_projects', FACTORY_PROJECT_COLUMNS, { id, workspace_id: workspaceId })
    if (!data) throw new AppError('factoryProjectNotFound')
    return data as FactoryProject
}

async function projectByRepo(workspaceId: number, repo: string): Promise<FactoryProject | null> {
    const { data, error } = await selectMaybeSingle(createServiceRoleClient(), 'factory_projects', FACTORY_PROJECT_COLUMNS, { workspace_id: workspaceId, repo })
    if (error) throw new AppError('generic')
    return data as FactoryProject | null
}

async function projectLimitsOf(workspaceId: number): Promise<FactoryProjectLimits | null> {
    const { data, error } = await selectMaybeSingle(createServiceRoleClient(), 'factory_controls', ['project_limits'] as const, { workspace_id: workspaceId })
    if (error) throw new AppError('generic')
    const limits = factoryProjectLimitsSchema.safeParse(data?.project_limits)
    return limits.success ? limits.data : null
}

export async function listFactoryProjects(workspaceId: number, userId: string, wantRepos: boolean): Promise<{ projects: FactoryProject[]; isOwner: boolean }> {
    const isOwner = await isFactoryOwner(workspaceId, userId)
    if (isOwner && wantRepos) wantFactoryRepos(workspaceId)
    const { data, error } = await selectMany(createServiceRoleClient(), 'factory_projects', FACTORY_PROJECT_COLUMNS, { workspace_id: workspaceId }, { column: 'created_at' })
    if (error) throw new AppError('generic')
    return { projects: (data ?? []) as FactoryProject[], isOwner }
}

async function insertProject(workspaceId: number, userId: string, repo: string, hostPath: string | null): Promise<FactoryProject> {
    const { data, error } = await createServiceRoleClient().from('factory_projects')
        .insert<ProjectInsert>({ workspace_id: workspaceId, repo, name: repo.split('/')[1], state: 'ready', host_path: hostPath, created_by: userId })
        .select(FACTORY_PROJECT_COLUMNS.join(','))
        .single()
    if (error?.code === UNIQUE_VIOLATION) throw new AppError('factoryProjectExists', { repo })
    if (error || !data) throw new AppError('generic')
    return data as unknown as FactoryProject
}

export async function addRepoProject(workspaceId: number, userId: string, repo: string): Promise<FactoryProject> {
    await assertFactoryOwner(workspaceId, userId)
    if (!FACTORY_REPO_PATTERN.test(repo) || !projectsOf(workspaceId)?.repos.includes(repo)) throw new AppError('factoryRepoNotReachable', { repo })
    return insertProject(workspaceId, userId, repo, null)
}

export async function addGithubProject(workspaceId: number, userId: string, link: string): Promise<GithubAddOutcome> {
    await assertFactoryOwner(workspaceId, userId)
    const parsed = parseGithubRepoLink(link)
    if (!parsed.ok) throw new AppError('factoryProjectLinkInvalid')
    const [owner, name] = parsed.repo.split('/')
    const owners = projectsOf(workspaceId)?.owners
    const listed = owners ? owners.find(o => o.toLowerCase() === owner.toLowerCase()) : owner
    if (!listed) throw new AppError('factoryProjectOwnerNotAllowed', { owners: owners?.join(', ') ?? '' })
    const repo = `${listed}/${name}`
    const existing = await projectByRepo(workspaceId, repo)
    if (existing) return { project: existing, existed: true }
    const { limits, full } = await projectRoom(workspaceId)
    if (!limits) throw new AppError('factoryProjectQuotaUnset')
    if (full) throw new AppError('factoryProjectQuotaExceeded', { max: limits.max_count })
    const { data, error } = await createServiceRoleClient().from('factory_projects')
        .insert<ProjectInsert>({ workspace_id: workspaceId, repo, name, source: 'github', state: 'queued', created_by: userId })
        .select(FACTORY_PROJECT_COLUMNS.join(','))
        .single()
    if (error?.code === UNIQUE_VIOLATION) {
        const raced = await projectByRepo(workspaceId, repo)
        if (raced) return { project: raced, existed: true }
    }
    if (error || !data) throw new AppError('generic')
    return { project: data as unknown as FactoryProject, existed: false }
}

async function projectRoom(workspaceId: number): Promise<{ limits: FactoryProjectLimits | null; full: boolean }> {
    const limits = await projectLimitsOf(workspaceId)
    if (!limits) return { limits, full: false }
    const count = await selectCount(createServiceRoleClient(), 'factory_projects', { workspace_id: workspaceId })
    if (count.error) throw new AppError('generic')
    return { limits, full: (count.data ?? 0) >= limits.max_count }
}

export async function retryProject(workspaceId: number, userId: string, id: number): Promise<FactoryProject> {
    await assertFactoryOwner(workspaceId, userId)
    if ((await projectRow(workspaceId, id)).source === 'upload') throw new AppError('factoryProjectUploadRetry')
    const { error } = await createServiceRoleClient().from('factory_projects')
        .update<ProjectUpdate>({ state: 'queued', error_code: null, progress_done: null, progress_total: null, updated_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', workspaceId).eq('state', 'failed')
    if (error) throw new AppError('generic')
    return projectRow(workspaceId, id)
}

function uploadName(raw: string | null): string {
    const name = Array.from((raw ?? '').replace(/\p{Cc}/gu, '').trim()).slice(0, UPLOAD_NAME_MAX).join('').trim()
    return name || UPLOAD_NAME_DEFAULT
}

function measured(body: ReadableStream<Uint8Array>, limit: number) {
    const hash = createHash('sha256')
    const seen = { bytes: 0, over: false }
    const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            seen.bytes += chunk.byteLength
            if (seen.bytes > limit) {
                seen.over = true
                controller.error(new Error('upload_too_large'))
                return
            }
            hash.update(chunk)
            controller.enqueue(chunk)
        },
    }))
    return { stream, seen, sha256: () => hash.digest('hex') }
}

const failedChange = (code: FactoryProjectErrorCode): ProjectUpdate => ({ state: 'failed', error_code: code, progress_done: null, progress_total: null, updated_at: new Date().toISOString() })

async function dropUploadObject(workspaceId: number, id: number): Promise<void> {
    await removePrivateFiles(createServiceRoleClient(), UPLOAD_BUCKET, [uploadPath(workspaceId, id)]).catch(() => undefined)
}

export async function uploadProject(workspaceId: number, userId: string, upload: { name: string | null; length: string | null; body: ReadableStream<Uint8Array> | null }): Promise<UploadOutcome> {
    await assertFactoryOwner(workspaceId, userId)
    const { limits, full } = await projectRoom(workspaceId)
    if (!limits) return { code: 'quota_unset' }
    if (full) return { code: 'quota_exceeded' }
    if (!upload.body || !/^[0-9]{1,15}$/.test(upload.length ?? '')) return { code: 'length_required' }
    const length = Number(upload.length)
    const max = limits.upload_max_mb * MB
    if (length > max) return { code: 'upload_too_large' }
    const supabase = createServiceRoleClient()
    const { data, error } = await supabase.from('factory_projects')
        .insert<ProjectInsert>({ workspace_id: workspaceId, repo: null, name: uploadName(upload.name), source: 'upload', state: 'uploading', created_by: userId })
        .select(FACTORY_PROJECT_COLUMNS.join(','))
        .single()
    if (error || !data) return { code: 'unknown' }
    const id = (data as unknown as FactoryProject).id
    const body = measured(upload.body, Math.min(length, max))
    const stored = await uploadPrivateFile(supabase, UPLOAD_BUCKET, uploadPath(workspaceId, id), body.stream, 'application/x-tar').then(() => true, () => false)
    const refusal: UploadRefusal | null = body.seen.over ? 'upload_too_large' : !stored || body.seen.bytes !== length ? 'unknown' : null
    if (!refusal) {
        const queued = await supabase.from('factory_projects')
            .update<ProjectUpdate>({ state: 'queued', upload_sha256: body.sha256(), upload_bytes: body.seen.bytes, updated_at: new Date().toISOString() })
            .eq('id', id).eq('workspace_id', workspaceId).eq('state', 'uploading')
            .select(FACTORY_PROJECT_COLUMNS.join(','))
            .single()
        if (!queued.error && queued.data) return { project: queued.data as unknown as FactoryProject }
    }
    await dropUploadObject(workspaceId, id)
    await supabase.from('factory_projects').update<ProjectUpdate>(failedChange(refusal === 'upload_too_large' ? 'upload_too_large' : 'unknown')).eq('id', id).eq('workspace_id', workspaceId)
    return { code: refusal ?? 'unknown' }
}

export async function takeUploadArchive(workspaceId: number, id: number): Promise<ReadableStream<Uint8Array> | null> {
    const supabase = createServiceRoleClient()
    const { data, error } = await supabase.from('factory_projects')
        .update<ProjectUpdate>({ state: 'unpacking', updated_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', workspaceId).eq('source', 'upload').eq('state', 'queued')
        .select('id')
    if (error) throw new AppError('generic')
    if (!data?.length) return null
    const object = await supabase.storage.from(UPLOAD_BUCKET).download(uploadPath(workspaceId, id)).asStream()
    if (object.error || !object.data) throw new AppError('generic')
    return object.data as ReadableStream<Uint8Array>
}

type ProjectStateRow = { id: number; source: string; repo: string | null; state: string; error_code: string | null; progress_done: number | null; progress_total: number | null }

function identifiedChange(item: FactoryProjectItem, owners: readonly string[] | undefined): ProjectUpdate {
    const repo = item.identified_repo
    if (!repo || !isSafeFactoryRepo(repo)) return failedChange('no_github_remote')
    if (!owners?.includes(repo.split('/')[0])) return failedChange('owner_not_allowed')
    const dropped = factoryProjectDroppedSchema.safeParse(item.dropped ?? [])
    return { state: 'cloning', repo, upload_head: item.head ?? null, dropped: dropped.success ? dropped.data : [], error_code: null, progress_done: null, progress_total: null, updated_at: new Date().toISOString() }
}

function reportedChange(row: ProjectStateRow, item: FactoryProjectItem, owners: readonly string[] | undefined): ProjectUpdate | null {
    if (!FACTORY_MOVES[row.source === 'upload' ? 'upload' : 'github'][row.state as FactoryProjectState]?.includes(item.state)) return null
    if (row.repo === null && item.state !== 'unpacking' && item.state !== 'failed') return row.state === 'unpacking' && item.state === 'cloning' ? identifiedChange(item, owners) : null
    const progress = PROGRESS_STATES.includes(item.state) && item.progress && item.progress.done <= item.progress.total ? item.progress : null
    const next = { state: item.state, error_code: item.state === 'failed' ? item.error_code ?? 'unknown' : null, progress_done: progress?.done ?? null, progress_total: progress?.total ?? null }
    const same = next.state === row.state && next.error_code === row.error_code && next.progress_done === row.progress_done && next.progress_total === row.progress_total
    return same ? null : { ...next, updated_at: new Date().toISOString() }
}

export async function applyFactoryProjectItems(workspaceId: number, items: FactoryProjectItem[]): Promise<void> {
    const bound = (await projectLimitsOf(workspaceId))?.max_count ?? ITEMS_MAX
    const reported = new Map(items.slice(0, bound).map(item => [item.id, item]))
    if (!reported.size) return
    const { data, error } = await selectMany(createServiceRoleClient(), 'factory_projects', ['id', 'source', 'repo', 'state', 'error_code', 'progress_done', 'progress_total'] as const, { workspace_id: workspaceId, id: [...reported.keys()] })
    if (error) throw new AppError('generic')
    const owners = projectsOf(workspaceId)?.owners
    for (const row of data ?? []) {
        const item = reported.get(row.id)
        let change = item ? reportedChange(row, item, owners) : null
        if (!change) continue
        if (change.repo && await projectByRepo(workspaceId, change.repo)) change = failedChange('already_added')
        const write = (update: ProjectUpdate) => createServiceRoleClient().from('factory_projects').update<ProjectUpdate>(update).eq('id', row.id).eq('workspace_id', workspaceId).eq('state', row.state)
        let written = await write(change)
        if (written.error?.code === UNIQUE_VIOLATION) {
            change = failedChange('already_added')
            written = await write(change)
        }
        if (written.error) throw new AppError('generic')
        if (row.source === 'upload' && change.state !== row.state && (change.state === 'cloning' || change.state === 'failed')) await dropUploadObject(workspaceId, row.id)
    }
}

export async function addPathProject(workspaceId: number, userId: string, rawPath: string, now = Date.now()): Promise<PathOutcome> {
    await assertFactoryOwner(workspaceId, userId)
    const path = rawPath.trim()
    if (!path || path.length > MAX_PATH || path.includes('\0')) throw new AppError('factoryPathInvalid')
    const ask = currentProjectAsk(workspaceId)
    if (ask?.kind !== 'path' || ask.path !== path) {
        askProjectCheck(workspaceId, { kind: 'path', path, at: factoryStamp(now), sentAt: null })
        return { state: 'checking' }
    }
    const held = getFactorySnapshot(workspaceId)
    const probe = ask.sentAt !== null && held && held.receivedAt > ask.sentAt ? held.snapshot.projects?.probes.at(-1) : undefined
    if (!probe) {
        if (now - Date.parse(ask.at) < CHECK_GIVES_UP_MS) return { state: 'checking' }
        clearProjectAsk(workspaceId)
        return { state: 'timedOut' }
    }
    clearProjectAsk(workspaceId)
    if (!probe.ok || !FACTORY_REPO_PATTERN.test(probe.repo)) return { state: 'refused', code: probe.code || 'unknown' }
    return { state: 'added', project: await insertProject(workspaceId, userId, probe.repo, probe.path) }
}

export async function selectProject(workspaceId: number, userId: string, id: number, now = Date.now()): Promise<SelectOutcome> {
    await assertFactoryOwner(workspaceId, userId)
    const row = await projectRow(workspaceId, id)
    if (row.state !== 'ready' || !row.repo) throw new AppError('factoryProjectNotReady', { name: row.name })
    if (row.active) return { state: 'selected' }
    const ask = currentProjectAsk(workspaceId)
    if (ask?.kind !== 'repo' || ask.repo !== row.repo) {
        askProjectCheck(workspaceId, { kind: 'repo', repo: row.repo, at: factoryStamp(now), sentAt: null })
        return { state: 'checking' }
    }
    const asked = Date.parse(ask.at)
    const ready = projectsOf(workspaceId)?.ready.find(r => r.repo === row.repo && Date.parse(r.at) >= asked)
    if (!ready) {
        if (now - asked < CHECK_GIVES_UP_MS) return { state: 'checking' }
        clearProjectAsk(workspaceId)
        return { state: 'timedOut' }
    }
    clearProjectAsk(workspaceId)
    if (!ready.passed) return { state: 'refused', lines: ready.lines.filter(l => !l.ok) }
    const supabase = createServiceRoleClient()
    const cleared = await supabase.from('factory_projects').update<ProjectUpdate>({ active: false }).eq('workspace_id', workspaceId).eq('active', true)
    if (cleared.error) throw new AppError('generic')
    const set = await supabase.from('factory_projects').update<ProjectUpdate>({ active: true, activated_at: ask.at, activated_by: userId }).eq('id', id).eq('workspace_id', workspaceId)
    if (set.error) throw new AppError('generic')
    return { state: 'selected' }
}

export async function removeProject(workspaceId: number, userId: string, id: number): Promise<void> {
    await assertFactoryOwner(workspaceId, userId)
    const row = await projectRow(workspaceId, id)
    if (row.active) throw new AppError('factoryProjectActive', { repo: row.repo ?? row.name })
    const { error } = await createServiceRoleClient().from('factory_projects').delete().eq('id', id).eq('workspace_id', workspaceId).eq('active', false)
    if (error) throw new AppError('generic')
    if (row.source === 'upload') await dropUploadObject(workspaceId, id)
}

type FactoryProjectsAnswer = {
    workspace_id: number
    limits: FactoryProjectLimits | null
    ids: number[]
    queue: ({ id: number; repo: string; source: 'github' } | { id: number; source: 'upload'; state: FactoryProjectState; sha256: string | null; bytes: number | null; repo?: string })[]
}
export type FactoryReportAnswer = ProjectAskAnswer & { project?: { repo: string; by: string; at: string }; projects?: FactoryProjectsAnswer }

async function projectsAnswer(workspaceId: number): Promise<FactoryProjectsAnswer> {
    const supabase = createServiceRoleClient()
    const [limits, ids, queue] = await Promise.all([
        projectLimitsOf(workspaceId),
        selectMany(supabase, 'factory_projects', ['id'] as const, { workspace_id: workspaceId }, { column: 'id' }, ITEMS_MAX),
        selectMany(supabase, 'factory_projects', ['id', 'repo', 'source', 'state', 'upload_sha256', 'upload_bytes'] as const, { workspace_id: workspaceId, state: QUEUE_STATES }, { column: 'created_at' }, QUEUE_MAX),
    ])
    if (ids.error || queue.error) throw new AppError('generic')
    return {
        workspace_id: workspaceId,
        limits,
        ids: (ids.data ?? []).map(r => r.id),
        queue: (queue.data ?? []).map(r => r.source === 'upload'
            ? { id: r.id, source: 'upload' as const, state: r.state as FactoryProjectState, sha256: r.upload_sha256, bytes: r.upload_bytes, ...(r.repo ? { repo: r.repo } : {}) }
            : { id: r.id, repo: r.repo ?? '', source: 'github' as const }),
    }
}

export async function factoryReportAnswer(workspaceId: number): Promise<FactoryReportAnswer> {
    const [{ data }, projects] = await Promise.all([
        selectMaybeSingle(createServiceRoleClient(), 'factory_projects', ['repo', 'activated_at', 'activated_by'] as const, { workspace_id: workspaceId, active: true }),
        projectsAnswer(workspaceId).catch(() => undefined),
    ])
    const answer = projects ? { ...takeProjectAskAnswer(workspaceId), projects } : takeProjectAskAnswer(workspaceId)
    if (!data?.activated_at || !data.repo) return answer
    return { ...answer, project: { repo: data.repo, by: data.activated_by ?? '', at: factoryStamp(Date.parse(data.activated_at)) } }
}
