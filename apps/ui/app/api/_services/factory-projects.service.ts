import 'server-only'

import {
    FACTORY_REPO_PATTERN,
    factoryProjectLimitsSchema,
    parseGithubRepoLink,
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
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

type ProjectInsert = Database['public']['Tables']['factory_projects']['Insert']
type ProjectUpdate = Database['public']['Tables']['factory_projects']['Update']

const FACTORY_PROJECT_COLUMNS = ['id', 'name', 'source', 'repo', 'state', 'error_code', 'progress_done', 'progress_total', 'active', 'activated_at', 'created_at', 'updated_at'] as const
export type FactoryProject = {
    id: number; name: string; source: FactoryProjectSource; repo: string; state: FactoryProjectState; error_code: FactoryProjectErrorCode | null
    progress_done: number | null; progress_total: number | null; active: boolean; activated_at: string | null; created_at: string; updated_at: string
}
export type GithubAddOutcome = { project: FactoryProject; existed: boolean }
export type FactoryReadyLine = FactoryProjects['ready'][number]['lines'][number]

export type PathOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; code: FactoryProbeCode | 'unknown' } | { state: 'added'; project: FactoryProject }
export type SelectOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; lines: FactoryReadyLine[] } | { state: 'selected' }

const CHECK_GIVES_UP_MS = 10 * 60_000
const MAX_PATH = 4096
const UNIQUE_VIOLATION = '23505'
const ITEMS_MAX = 1000
const QUEUE_MAX = 20
const QUEUE_STATES: FactoryProjectState[] = ['queued', 'cloning']
const PROGRESS_STATES: readonly FactoryProjectState[] = ['cloning', 'uploading', 'unpacking']
const FACTORY_MOVES: Partial<Record<FactoryProjectState, readonly FactoryProjectState[]>> = {
    queued: ['cloning', 'ready', 'failed'],
    cloning: ['cloning', 'ready', 'failed'],
    ready: ['ready', 'failed'],
    failed: ['failed'],
}

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
    const limits = await projectLimitsOf(workspaceId)
    if (!limits) throw new AppError('factoryProjectQuotaUnset')
    const count = await selectCount(createServiceRoleClient(), 'factory_projects', { workspace_id: workspaceId })
    if (count.error) throw new AppError('generic')
    if ((count.data ?? 0) >= limits.max_count) throw new AppError('factoryProjectQuotaExceeded', { max: limits.max_count })
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

export async function retryProject(workspaceId: number, userId: string, id: number): Promise<FactoryProject> {
    await assertFactoryOwner(workspaceId, userId)
    const { error } = await createServiceRoleClient().from('factory_projects')
        .update<ProjectUpdate>({ state: 'queued', error_code: null, progress_done: null, progress_total: null, updated_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', workspaceId).eq('state', 'failed')
    if (error) throw new AppError('generic')
    return projectRow(workspaceId, id)
}

type ProjectStateRow = { id: number; state: string; error_code: string | null; progress_done: number | null; progress_total: number | null }

function reportedChange(row: ProjectStateRow, item: FactoryProjectItem): ProjectUpdate | null {
    if (!FACTORY_MOVES[row.state as FactoryProjectState]?.includes(item.state)) return null
    const progress = PROGRESS_STATES.includes(item.state) && item.progress && item.progress.done <= item.progress.total ? item.progress : null
    const next = { state: item.state, error_code: item.state === 'failed' ? item.error_code ?? 'unknown' : null, progress_done: progress?.done ?? null, progress_total: progress?.total ?? null }
    const same = next.state === row.state && next.error_code === row.error_code && next.progress_done === row.progress_done && next.progress_total === row.progress_total
    return same ? null : { ...next, updated_at: new Date().toISOString() }
}

export async function applyFactoryProjectItems(workspaceId: number, items: FactoryProjectItem[]): Promise<void> {
    const bound = (await projectLimitsOf(workspaceId))?.max_count ?? ITEMS_MAX
    const reported = new Map(items.slice(0, bound).map(item => [item.id, item]))
    if (!reported.size) return
    const { data, error } = await selectMany(createServiceRoleClient(), 'factory_projects', ['id', 'state', 'error_code', 'progress_done', 'progress_total'] as const, { workspace_id: workspaceId, id: [...reported.keys()] })
    if (error) throw new AppError('generic')
    for (const row of data ?? []) {
        const item = reported.get(row.id)
        const change = item ? reportedChange(row, item) : null
        if (!change) continue
        const written = await createServiceRoleClient().from('factory_projects').update<ProjectUpdate>(change).eq('id', row.id).eq('workspace_id', workspaceId).eq('state', row.state)
        if (written.error) throw new AppError('generic')
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
    if (row.state !== 'ready') throw new AppError('factoryProjectNotReady', { name: row.name })
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
    if (row.active) throw new AppError('factoryProjectActive', { repo: row.repo })
    const { error } = await createServiceRoleClient().from('factory_projects').delete().eq('id', id).eq('workspace_id', workspaceId).eq('active', false)
    if (error) throw new AppError('generic')
}

type FactoryProjectsAnswer = {
    workspace_id: number
    limits: FactoryProjectLimits | null
    ids: number[]
    queue: { id: number; repo: string; source: FactoryProjectSource }[]
}
export type FactoryReportAnswer = ProjectAskAnswer & { project?: { repo: string; by: string; at: string }; projects?: FactoryProjectsAnswer }

async function projectsAnswer(workspaceId: number): Promise<FactoryProjectsAnswer> {
    const supabase = createServiceRoleClient()
    const [limits, ids, queue] = await Promise.all([
        projectLimitsOf(workspaceId),
        selectMany(supabase, 'factory_projects', ['id'] as const, { workspace_id: workspaceId }, { column: 'id' }, ITEMS_MAX),
        selectMany(supabase, 'factory_projects', ['id', 'repo', 'source'] as const, { workspace_id: workspaceId, state: QUEUE_STATES }, { column: 'created_at' }, QUEUE_MAX),
    ])
    if (ids.error || queue.error) throw new AppError('generic')
    return {
        workspace_id: workspaceId,
        limits,
        ids: (ids.data ?? []).map(r => r.id),
        queue: (queue.data ?? []).map(r => ({ id: r.id, repo: r.repo, source: r.source as FactoryProjectSource })),
    }
}

export async function factoryReportAnswer(workspaceId: number): Promise<FactoryReportAnswer> {
    const [{ data }, projects] = await Promise.all([
        selectMaybeSingle(createServiceRoleClient(), 'factory_projects', ['repo', 'activated_at', 'activated_by'] as const, { workspace_id: workspaceId, active: true }),
        projectsAnswer(workspaceId).catch(() => undefined),
    ])
    const answer = projects ? { ...takeProjectAskAnswer(workspaceId), projects } : takeProjectAskAnswer(workspaceId)
    if (!data?.activated_at) return answer
    return { ...answer, project: { repo: data.repo, by: data.activated_by ?? '', at: factoryStamp(Date.parse(data.activated_at)) } }
}
