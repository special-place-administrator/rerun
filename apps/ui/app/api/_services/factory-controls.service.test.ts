import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

import { actOnWorkOrder, cancelWorkOrder, controlsReportAnswer, createWorkOrder, setFactoryState, setProviderEnabled } from './factory-controls.service'

vi.mock('server-only', () => ({}))
vi.mock('@/app/api/_auth/ownership', () => ({ workspaceFounderUserId: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingle: vi.fn(), selectMany: vi.fn() }))

const OWNER = 'owner-1'
const MEMBER = 'member-2'
const upsert = vi.fn()
const insert = vi.fn()
const from = vi.fn()

type Rows = { factory_projects?: object | null; factory_controls?: object | null; workspace_members?: object | null }
function rows(by: Rows, orders: object[] = []) {
    vi.mocked(selectMaybeSingle).mockImplementation((async (_client: unknown, table: keyof Rows) => ({ data: table === 'workspace_members' ? { role: 'admin' } : by[table] ?? null, error: null })) as never)
    vi.mocked(selectMany).mockResolvedValue({ data: orders, error: null } as never)
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceFounderUserId).mockResolvedValue(OWNER)
    upsert.mockResolvedValue({ error: null })
    from.mockReturnValue({ upsert, insert })
    vi.mocked(createServiceRoleClient).mockReturnValue({ from } as never)
})

describe('factory controls: owner only', () => {
    it('refuses state, provider and work-order changes to a member who is not the workspace owner, and reads or writes nothing', async () => {
        const refused = { code: 'factoryOwnerOnly', name: 'AuthorizationError' }
        await expect(setFactoryState(401, MEMBER, 'RUNNING')).rejects.toMatchObject(refused)
        await expect(setFactoryState(401, MEMBER, 'STOPPED')).rejects.toMatchObject(refused)
        await expect(setProviderEnabled(401, MEMBER, 'conn-a', false)).rejects.toMatchObject(refused)
        await expect(createWorkOrder(401, MEMBER, { repo: 'acme/app', kind: 'issue', issues: [12], text: '' })).rejects.toMatchObject(refused)
        await expect(cancelWorkOrder(401, MEMBER, 'order-1')).rejects.toMatchObject(refused)
        await expect(actOnWorkOrder(401, MEMBER, 'order-1', 'retry', 12)).rejects.toMatchObject(refused)
        expect(from).not.toHaveBeenCalled()
        expect(selectMaybeSingle).not.toHaveBeenCalled()
    })

    it('refuses a work order for a project that is not the active one, and inserts nothing', async () => {
        rows({ factory_projects: { repo: 'acme/app' } })
        await expect(createWorkOrder(402, OWNER, { repo: 'acme/site', kind: 'issue', issues: [7], text: '' })).rejects.toMatchObject({ code: 'factoryOrderNotActiveProject', params: { repo: 'acme/site' } })
        expect(insert).not.toHaveBeenCalled()
        expect(from).not.toHaveBeenCalled()
    })
})

describe('factory_report answer for controls', () => {
    it('sends nothing for a brand-new workspace, then the stored click with a fresh at each time, the off-list and the active order of the active project', async () => {
        rows({})
        expect(await controlsReportAnswer(403)).toEqual({})

        await setFactoryState(403, OWNER, 'RUNNING', Date.parse('2026-11-23T20:00:00.100Z'))
        await setFactoryState(403, OWNER, 'RUNNING', Date.parse('2026-11-23T20:00:00.900Z'))
        const clicks = upsert.mock.calls.map(([payload]) => payload.state_at)
        expect(clicks).toEqual(['2026-11-23T20:00:00.100Z', '2026-11-23T20:00:00.900Z'])

        rows({
            factory_projects: { repo: 'acme/app' },
            factory_controls: { state: 'RUNNING', state_by: OWNER, state_at: '2026-11-23T20:00:00.900+00:00', providers_off: ['conn-b'], providers_by: OWNER, providers_at: '2026-11-23T19:59:00+00:00' },
        }, [{ id: 'order-1', repo: 'acme/app', kind: 'all_issues', issues: [3, 1, 2], text: '', status: 'active', action: { action: 'skip', issue: 1, by: OWNER, at: '2026-11-23T20:05:00.000Z' }, created_by: OWNER, created_at: '2026-11-23T20:01:00+00:00', cancelled_by: null, cancelled_at: null }])
        expect(await controlsReportAnswer(403)).toEqual({
            control: { state: 'RUNNING', by: OWNER, at: '2026-11-23T20:00:00.900Z' },
            providers: { off: ['conn-b'], by: OWNER, at: '2026-11-23T19:59:00.000Z' },
            work_order: { id: 'order-1', repo: 'acme/app', kind: 'all_issues', issues: [3, 1, 2], text: '', by: OWNER, at: '2026-11-23T20:01:00.000Z' },
            work_order_action: { action: 'skip', order_id: 'order-1', issue: 1, by: OWNER, at: '2026-11-23T20:05:00.000Z' },
        })
        expect(selectMany).toHaveBeenCalledWith(expect.anything(), 'factory_work_orders', expect.anything(), { workspace_id: 403, repo: 'acme/app' }, { column: 'created_at', ascending: false }, 1)
    })
})
