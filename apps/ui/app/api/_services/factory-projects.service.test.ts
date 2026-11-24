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
        vi.mocked(selectMany).mockResolvedValue({ data: [], error: null } as never)
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
        expect(vi.mocked(selectMany).mock.calls.find(c => c[1] === 'factory_projects' && 'repo' in c[3])?.[3]).toEqual({ workspace_id: 501, repo: { ilike: 'special-place-ai-heaven/x' } })
    })

    it('returns the existing row for the same repo in another case, and inserts nothing', async () => {
        putFactorySnapshot(502, { version: 1, madeAt: '2026-11-24T06:00:00Z', projects: { repos: [], ready: [], probes: [], owners: ['acme'] } } as never)
        const existing = { id: 9, name: 'my_app', source: 'github', repo: 'acme/my_app', state: 'ready' }
        vi.mocked(selectMany).mockImplementation(((_c: unknown, table: string, _s: unknown, filters: { repo?: { ilike?: string } }) => Promise.resolve({
            data: table === 'factory_projects' && filters.repo?.ilike === 'acme/My\\_App' ? [existing] : [], error: null,
        })) as never)
        expect(await addGithubProject(502, OWNER, 'https://github.com/acme/My_App')).toEqual({ project: existing, existed: true })
        expect(inserts).toEqual([])
    })
})

describe('factory projects: uploads cut off mid-way', () => {
    it('fails an upload still uploading after 30 minutes and removes its object, and leaves a recent one alone', async () => {
        const stale = { id: 21, updated_at: new Date(Date.now() - 31 * 60_000).toISOString() }
        const recent = { id: 22, updated_at: new Date(Date.now() - 60_000).toISOString() }
        const writes: { payload: unknown; eqs: unknown[][] }[] = []
        const removed: string[][] = []
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)
        vi.mocked(selectMany).mockImplementation(((_c: unknown, _t: string, _s: unknown, filters: { state?: unknown; updated_at?: { lt: string } }) => Promise.resolve({
            data: filters.state === 'uploading' ? [stale, recent].filter(r => filters.updated_at && r.updated_at < filters.updated_at.lt) : [], error: null,
        })) as never)
        from.mockImplementation(() => ({ update: (payload: unknown) => {
            const write = { payload, eqs: [] as unknown[][] }
            writes.push(write)
            const query = { eq: (...args: unknown[]) => { write.eqs.push(args); return query }, select: () => Promise.resolve({ data: [{ id: 21 }], error: null }) }
            return query
        } }))
        vi.mocked(createServiceRoleClient).mockReturnValue({ from, storage: { from: () => ({ remove: (paths: string[]) => { removed.push(paths); return Promise.resolve({ error: null }) } }) } } as never)
        await factoryReportAnswer(701)
        expect(writes).toEqual([{ payload: expect.objectContaining({ state: 'failed', error_code: 'timed_out' }), eqs: [['id', 21], ['workspace_id', 701], ['state', 'uploading'], ['updated_at', stale.updated_at]] }])
        expect(removed).toEqual([['701/21.tar']])
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

describe('factory projects: an upload identified by the factory', () => {
    const writes: unknown[] = []
    const removed: string[][] = []
    const upload = (id: number, state: string) => ({ id, source: 'upload', repo: null, state, error_code: null, progress_done: null, progress_total: null })
    const identified = (id: number, repo: string) => ({ id, state: 'cloning' as const, progress: null, error_code: null, identified_repo: repo, head: 'a'.repeat(40), dropped: [{ label: 'Env file', path: '.env' }] })

    beforeEach(() => {
        writes.length = 0
        removed.length = 0
        const done = { eq: () => done, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) }
        from.mockImplementation(() => ({ update: (payload: unknown) => { writes.push(payload); return done } }))
        vi.mocked(createServiceRoleClient).mockReturnValue({ from, storage: { from: () => ({ remove: (paths: string[]) => { removed.push(paths); return Promise.resolve({ error: null }) } }) } } as never)
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)
        putFactorySnapshot(601, { version: 1, madeAt: '2026-11-24T06:00:00Z', projects: { repos: [], ready: [], probes: [], owners: ['special-place-ai-heaven'] } } as never)
    })

    it('takes the repo only on unpacking to cloning, from a listed owner, and deletes the stored folder', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: [upload(1, 'unpacking'), upload(2, 'queued'), upload(3, 'unpacking'), upload(4, 'unpacking')], error: null } as never)
        await applyFactoryProjectItems(601, [
            identified(1, 'special-place-ai-heaven/moldwright'),
            identified(2, 'special-place-ai-heaven/moldwright'),
            identified(3, 'someone-else/moldwright'),
            identified(4, 'special-place-ai-heaven/..'),
        ])
        expect(writes).toEqual([
            expect.objectContaining({ state: 'cloning', repo: 'special-place-ai-heaven/moldwright', upload_head: 'a'.repeat(40), dropped: [{ label: 'Env file', path: '.env' }] }),
            expect.objectContaining({ state: 'failed', error_code: 'owner_not_allowed' }),
            expect.objectContaining({ state: 'failed', error_code: 'no_github_remote' }),
        ])
        expect(removed).toEqual([['601/1.tar'], ['601/3.tar'], ['601/4.tar']])
    })

    it('fails an upload whose repo another project of the workspace already has', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: [upload(5, 'unpacking')], error: null } as never)
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: { id: 9, repo: 'special-place-ai-heaven/moldwright' }, error: null } as never)
        await applyFactoryProjectItems(601, [identified(5, 'special-place-ai-heaven/moldwright')])
        expect(writes).toEqual([expect.objectContaining({ state: 'failed', error_code: 'already_added' })])
    })
})
