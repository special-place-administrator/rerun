import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { askProjectCheck, clearProjectAsk } from '@/lib/factory/project-asks'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

import { addPathProject, addRepoProject, factoryReportAnswer, removeProject, selectProject } from './factory-projects.service'

vi.mock('server-only', () => ({}))
vi.mock('@/app/api/_auth/ownership', () => ({ workspaceFounderUserId: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingle: vi.fn(), selectMany: vi.fn() }))

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

    it('refuses to remove the active project, even to the owner, and deletes nothing', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: { id: 7, repo: 'acme/app', host_path: null, active: true, activated_at: '2026-11-23T18:00:00Z', created_at: '2026-11-23T17:00:00Z' }, error: null } as never)
        await expect(removeProject(202, OWNER, 7)).rejects.toMatchObject({ code: 'factoryProjectActive', params: { repo: 'acme/app' } })
        expect(from).not.toHaveBeenCalled()
    })
})

describe('factory_report answer', () => {
    beforeEach(() => { clearProjectAsk(301); clearProjectAsk(302) })

    it('adds nothing for a workspace with no project and nothing pending, so the answer stays { kept }', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)
        expect(await factoryReportAnswer(301)).toEqual({})
    })

    it('carries the active project with the moment it was asked for, and the pending check', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: { repo: 'acme/app', activated_at: '2026-11-23T18:00:00.000+00:00', activated_by: OWNER }, error: null } as never)
        askProjectCheck(302, { kind: 'repo', repo: 'acme/site', at: '2026-11-23T18:05:00Z', sentAt: null })
        const answer = await factoryReportAnswer(302)
        expect(answer).toEqual({ project: { repo: 'acme/app', by: OWNER, at: '2026-11-23T18:00:00Z' }, check: { repo: 'acme/site', at: '2026-11-23T18:05:00Z' } })
        expect(await factoryReportAnswer(302)).toEqual(answer)
    })
})
