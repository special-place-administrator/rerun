import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

import { actOnWorkOrder, cancelWorkOrder, controlsReportAnswer, createWorkOrder, setFactoryState, setFactoryThrottle, setProviderEnabled } from './factory-controls.service'

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

    it('refuses the pool and seats to a member, sends no throttle before the first set, then the stored pool and seats with a fresh at each time', async () => {
        const refused = { code: 'factoryOwnerOnly', name: 'AuthorizationError' }
        await expect(setFactoryThrottle(404, MEMBER, { maxGhosts: 16 })).rejects.toMatchObject(refused)
        await expect(setFactoryThrottle(404, MEMBER, { station: 'coder', seats: 5 })).rejects.toMatchObject(refused)
        expect(from).not.toHaveBeenCalled()

        rows({ factory_controls: { state: 'RUNNING', state_by: OWNER, state_at: '2026-11-23T20:00:00+00:00', providers_off: [], providers_by: null, providers_at: null, max_ghosts: 1, stations: {}, throttle_by: null, throttle_at: null } })
        expect(await controlsReportAnswer(404)).not.toHaveProperty('throttle')

        await expect(setFactoryThrottle(404, OWNER, { maxGhosts: 33 })).rejects.toMatchObject({ code: 'factoryInputInvalid' })
        await setFactoryThrottle(404, OWNER, { maxGhosts: 16 }, Date.parse('2026-11-23T21:00:00.100Z'))
        await setFactoryThrottle(404, OWNER, { maxGhosts: 16 }, Date.parse('2026-11-23T21:00:00.900Z'))
        expect(upsert.mock.calls.map(([payload]) => [payload.max_ghosts, payload.throttle_at])).toEqual([[16, '2026-11-23T21:00:00.100Z'], [16, '2026-11-23T21:00:00.900Z']])

        rows({ factory_controls: { state: null, state_by: null, state_at: null, providers_off: [], providers_by: null, providers_at: null, max_ghosts: 16, stations: { coder: 5, reviewer: 6 }, throttle_by: OWNER, throttle_at: '2026-11-23T21:00:00.900+00:00' } })
        expect(await controlsReportAnswer(404)).toEqual({ throttle: { max_ghosts: 16, stations: { coder: 5, reviewer: 6 }, by: OWNER, at: '2026-11-23T21:00:00.900Z' } })
    })
})
