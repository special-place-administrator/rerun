import 'server-only'

import { FACTORY_REPO_PATTERN, type FactoryProbeCode, type FactoryProjects } from '@moldwright/contracts'
import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { AuthorizationError } from '@/app/api/_auth/errors'
import type { Database } from '@/app/api/database.types'
import { getFactorySnapshot } from '@/lib/factory/snapshot-store'
import { askProjectCheck, clearProjectAsk, currentProjectAsk, factoryStamp, takeProjectAskAnswer, wantFactoryRepos, type ProjectAskAnswer } from '@/lib/factory/project-asks'
import { AppError } from '@/lib/i18n/action-error'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

type ProjectInsert = Database['public']['Tables']['factory_projects']['Insert']
type ProjectUpdate = Database['public']['Tables']['factory_projects']['Update']

const FACTORY_PROJECT_COLUMNS = ['id', 'repo', 'host_path', 'active', 'activated_at', 'created_at'] as const
export type FactoryProject = { id: number; repo: string; host_path: string | null; active: boolean; activated_at: string | null; created_at: string }
export type FactoryReadyLine = FactoryProjects['ready'][number]['lines'][number]

export type PathOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; code: FactoryProbeCode | 'unknown' } | { state: 'added'; project: FactoryProject }
export type SelectOutcome = { state: 'checking' } | { state: 'timedOut' } | { state: 'refused'; lines: FactoryReadyLine[] } | { state: 'selected' }

const CHECK_GIVES_UP_MS = 10 * 60_000
const MAX_PATH = 4096
const UNIQUE_VIOLATION = '23505'

async function isFactoryOwner(workspaceId: number, userId: string): Promise<boolean> {
    return (await workspaceFounderUserId(workspaceId)) === userId
}

async function assertFactoryOwner(workspaceId: number, userId: string): Promise<void> {
    if (!(await isFactoryOwner(workspaceId, userId))) throw new AuthorizationError('factoryOwnerOnly')
}

const projectsOf = (workspaceId: number): FactoryProjects | undefined => getFactorySnapshot(workspaceId)?.snapshot.projects

async function projectRow(workspaceId: number, id: number): Promise<FactoryProject> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'factory_projects', FACTORY_PROJECT_COLUMNS, { id, workspace_id: workspaceId })
    if (!data) throw new AppError('factoryProjectNotFound')
    return data
}

export async function listFactoryProjects(workspaceId: number, userId: string, wantRepos: boolean): Promise<{ projects: FactoryProject[]; isOwner: boolean }> {
    const isOwner = await isFactoryOwner(workspaceId, userId)
    if (isOwner && wantRepos) wantFactoryRepos(workspaceId)
    const { data, error } = await selectMany(createServiceRoleClient(), 'factory_projects', FACTORY_PROJECT_COLUMNS, { workspace_id: workspaceId }, { column: 'created_at' })
    if (error) throw new AppError('generic')
    return { projects: data ?? [], isOwner }
}

async function insertProject(workspaceId: number, userId: string, repo: string, hostPath: string | null): Promise<FactoryProject> {
    const { data, error } = await createServiceRoleClient().from('factory_projects')
        .insert<ProjectInsert>({ workspace_id: workspaceId, repo, host_path: hostPath, created_by: userId })
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

export type FactoryReportAnswer = ProjectAskAnswer & { project?: { repo: string; by: string; at: string } }

export async function factoryReportAnswer(workspaceId: number): Promise<FactoryReportAnswer> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'factory_projects', ['repo', 'activated_at', 'activated_by'] as const, { workspace_id: workspaceId, active: true })
    const asks = takeProjectAskAnswer(workspaceId)
    if (!data?.activated_at) return asks
    return { ...asks, project: { repo: data.repo, by: data.activated_by ?? '', at: factoryStamp(Date.parse(data.activated_at)) } }
}
