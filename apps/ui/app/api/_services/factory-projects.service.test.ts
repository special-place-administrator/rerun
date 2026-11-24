import { beforeEach, describe, expect, it, vi } from 'vitest'
import { factoryProjectsSchema } from '@moldwright/contracts'

import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { askProjectCheck, clearProjectAsk } from '@/lib/factory/project-asks'
import { putFactorySnapshot } from '@/lib/factory/snapshot-store'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

import { addGithubProject, addPathProject, addRepoProject, applyFactoryProjectItems, factoryReportAnswer, removeProject, selectProject } from './factory-projects.service'

vi.mock('server-only', () => ({}))
vi.mock('@/app/api/_auth/ownership', () => ({ workspaceFounderUserId: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingle: vi.fn(), selectMany: vi.fn(), selectCount: vi.fn() }))

const OWNER = 'owner-1'
const MEMBER = 'member-2'
const from = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceFounderUserId).mockResolvedValue(OWNER)
    vi.mocked(createServiceRoleClient).mockReturnValue({ from } as never)
})

describe('factory projects: owner only', () => {
    it('refuses add, remove and select to a member who is not the workspace owner, and writes nothing', async () => {
        const refused = { code: 'factoryOwnerOnly', name: 'AuthorizationError' }
        await expect(addRepoProject(201, MEMBER, 'acme/app')).rejects.toMatchObject(refused)
        await expect(addPathProject(201, MEMBER, '/srv/app')).rejects.toMatchObject(refused)
        await expect(removeProject(201, MEMBER, 1)).rejects.toMatchObject(refused)
        await expect(selectProject(201, MEMBER, 1)).rejects.toMatchObject(refused)
        expect(from).not.toHaveBeenCalled()
        expect(selectMaybeSingle).not.toHaveBeenCalled()
    })

    it('refuses to remove the active project, even to the owner, and refuses a founder who is no longer an admin', async () => {
        const row = { id: 7, repo: 'acme/app', host_path: null, active: true, activated_at: '2026-11-23T18:00:00Z', created_at: '2026-11-23T17:00:00Z' }
        vi.mocked(selectMaybeSingle).mockImplementation(((_c: unknown, table: string) => Promise.resolve({ data: table === 'workspace_members' ? { role: 'admin' } : row, error: null })) as never)
        await expect(removeProject(202, OWNER, 7)).rejects.toMatchObject({ code: 'factoryProjectActive', params: { repo: 'acme/app' } })
        vi.mocked(selectMaybeSingle).mockImplementation(((_c: unknown, table: string) => Promise.resolve({ data: table === 'workspace_members' ? { role: 'member' } : row, error: null })) as never)
        await expect(removeProject(202, OWNER, 7)).rejects.toMatchObject({ code: 'factoryOwnerOnly' })
        expect(from).not.toHaveBeenCalled()
    })
})

describe('factory_report answer', () => {
    beforeEach(() => { clearProjectAsk(301); clearProjectAsk(302) })

    beforeEach(() => { vi.mocked(selectMany).mockResolvedValue({ data: [], error: null } as never) })

    it('sends only the empty projects field for a workspace with no project and nothing pending', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)
        expect(await factoryReportAnswer(301)).toEqual({ projects: { workspace_id: 301, limits: null, ids: [], queue: [] } })
    })

    it('carries the active project with the moment it was asked for, and the pending check', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: { repo: 'acme/app', activated_at: '2026-11-23T18:00:00.000+00:00', activated_by: OWNER }, error: null } as never)
        askProjectCheck(302, { kind: 'repo', repo: 'acme/site', at: '2026-11-23T18:05:00Z', sentAt: null })
        const answer = await factoryReportAnswer(302)
        expect(answer).toEqual({ project: { repo: 'acme/app', by: OWNER, at: '2026-11-23T18:00:00Z' }, check: { repo: 'acme/site', at: '2026-11-23T18:05:00Z' }, projects: { workspace_id: 302, limits: null, ids: [], queue: [] } })
        expect(await factoryReportAnswer(302)).toEqual(answer)
    })

    it('still carries the active project and the pending check when the projects part fails', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: { repo: 'acme/app', activated_at: '2026-11-23T18:00:00.000+00:00', activated_by: OWNER }, error: null } as never)
        vi.mocked(selectMany).mockResolvedValue({ data: null, error: { message: 'down' } } as never)
        askProjectCheck(302, { kind: 'repo', repo: 'acme/site', at: '2026-11-23T18:05:00Z', sentAt: null })
        expect(await factoryReportAnswer(302)).toEqual({ project: { repo: 'acme/app', by: OWNER, at: '2026-11-23T18:00:00Z' }, check: { repo: 'acme/site', at: '2026-11-23T18:05:00Z' } })
    })
})

describe('factory projects: added by GitHub link', () => {
    const LIMITS = { max_count: 10, max_project_mb: 500, max_total_mb: 2000, upload_max_mb: 200, upload_max_files: 20000, upload_max_depth: 32, upload_max_file_mb: 50 }
    const inserts: unknown[] = []

    beforeEach(() => {
        inserts.length = 0
        vi.mocked(selectMaybeSingle).mockImplementation(((_c: unknown, table: string) => Promise.resolve({
            data: table === 'workspace_members' ? { role: 'admin' } : table === 'factory_controls' ? { project_limits: LIMITS } : null, error: null,
        })) as never)
        vi.mocked(selectCount).mockResolvedValue({ data: 0, error: null } as never)
        from.mockImplementation(() => ({ insert: (payload: Record<string, unknown>) => {
            inserts.push(payload)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 1, ...payload }, error: null }) }) }
        } }))
    })

    it('writes the owner with the case of the factory owners list', async () => {
        putFactorySnapshot(501, { version: 1, madeAt: '2026-11-24T06:00:00Z', projects: { repos: [], ready: [], probes: [], owners: ['special-place-ai-heaven'] } } as never)
        const added = await addGithubProject(501, OWNER, 'https://github.com/Special-Place-AI-Heaven/x')
        expect(added.existed).toBe(false)
        expect(inserts).toEqual([expect.objectContaining({ repo: 'special-place-ai-heaven/x', name: 'x' })])
        expect(vi.mocked(selectMaybeSingle).mock.calls.find(c => c[1] === 'factory_projects')?.[3]).toEqual({ workspace_id: 501, repo: 'special-place-ai-heaven/x' })
    })
})

describe('factory projects: probe codes', () => {
    it('keeps the projects field when a probe carries bad_root or a code the app does not know yet', () => {
        const probe = (code: string) => ({ path: '/srv/app', ok: false, code, message: '', repo: '' })
        const parsed = factoryProjectsSchema.parse({ repos: [], ready: [], probes: [probe('bad_root'), probe('later_code')] })
        expect(parsed.probes.map(p => p.code)).toEqual(['bad_root', 'unknown'])
    })
})

describe('factory projects: states reported by the factory', () => {
    const writes: unknown[] = []
    const row = (id: number, state: string) => ({ id, state, error_code: state === 'failed' ? 'unknown' : null, progress_done: null, progress_total: null })

    beforeEach(() => {
        writes.length = 0
        const done = { eq: () => done, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) }
        from.mockImplementation(() => ({ update: (payload: unknown) => { writes.push(payload); return done } }))
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)
    })

    it('ignores a forbidden transition and an id of another workspace, and writes the allowed one once', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: [row(1, 'failed'), row(2, 'queued')], error: null } as never)
        await applyFactoryProjectItems(401, [
            { id: 1, state: 'ready', progress: null, error_code: null },
            { id: 99, state: 'ready', progress: null, error_code: null },
            { id: 2, state: 'cloning', progress: { done: 5, total: 10, unit: 'bytes' }, error_code: null },
        ])
        expect(vi.mocked(selectMany).mock.calls[0][3]).toMatchObject({ workspace_id: 401 })
        expect(writes).toEqual([{ state: 'cloning', error_code: null, progress_done: 5, progress_total: 10, updated_at: expect.any(String) }])
    })

    it('keeps a code only with failed, and writes nothing for a row already in the reported state', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: [row(3, 'queued'), row(4, 'ready'), row(5, 'cloning')], error: null } as never)
        await applyFactoryProjectItems(402, [
            { id: 3, state: 'failed', progress: null, error_code: 'not_reachable' },
            { id: 4, state: 'ready', progress: null, error_code: null },
            { id: 5, state: 'ready', progress: null, error_code: 'not_reachable' },
        ])
        expect(writes).toEqual([
            { state: 'failed', error_code: 'not_reachable', progress_done: null, progress_total: null, updated_at: expect.any(String) },
            { state: 'ready', error_code: null, progress_done: null, progress_total: null, updated_at: expect.any(String) },
        ])
    })
})
