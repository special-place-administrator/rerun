import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { hashApiKey } from '@/lib/mcp/api-keys'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { fakeSupabase, type FakeSupabase, type SupabaseCall } from '@/test/supabase-fake'

import { GET } from './route'

vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/app/api/_auth/ownership', async importOriginal => ({ ...await importOriginal<typeof import('@/app/api/_auth/ownership')>(), workspaceFounderUserId: vi.fn() }))
vi.mock('@/app/api/_services/mcp-account.service', () => ({ dispatchAccountTool: vi.fn() }))
vi.mock('@/app/api/_services/agent.service', () => ({ deleteAgent: vi.fn() }))

const WORKSPACE_ID = 7
const FACTORY_KEY = 'rk_factory-key'
const MEMBER_KEY = 'rk_member-key'
const IMPORT_KEY = 'rk_import-key'
const OWNER = 'user-owner'
const MEMBER = 'user-member'
const TAR = new TextEncoder().encode('tar bytes')

const API_KEYS: Record<string, { id: string; workspace_id: number; revoked_at: null; created_by_user_id: string | null; scope: string }> = {
    [hashApiKey(FACTORY_KEY)]: { id: 'key-1', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, scope: 'account' },
    [hashApiKey(MEMBER_KEY)]: { id: 'key-2', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: MEMBER, scope: 'account' },
    [hashApiKey(IMPORT_KEY)]: { id: 'key-3', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, scope: 'agent_import' },
}

function eqValue(calls: readonly SupabaseCall[], column: string): unknown {
    return calls.find(call => call.method === 'eq' && call.args[0] === column)?.args[1]
}

function archiveRequest(token: string | null, id = '5') {
    const headers: Record<string, string> = { cookie: 'sb-session=signed-in-user' }
    if (token !== null) headers.authorization = `Bearer ${token}`
    return [new Request(`https://hub.test/api/factory/projects/${id}/archive`, { headers }), { params: Promise.resolve({ id }) }] as const
}

describe('GET /api/factory/projects/[id]/archive', () => {
    let db: FakeSupabase
    let queued: boolean
    const download = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
        queued = true
        vi.mocked(workspaceFounderUserId).mockResolvedValue(OWNER)
        db = fakeSupabase((table, calls) => {
            if (table === 'api_keys') return { data: API_KEYS[eqValue(calls, 'key_hash') as string] ?? null }
            if (table === 'workspaces') return { data: { subscription_status: 'active', is_sandbox: false } }
            if (table === 'workspace_members') return { data: { role: 'member', box_scope: 'all' } }
            if (table === 'factory_projects' && calls.some(c => c.method === 'update')) {
                const moved = queued && eqValue(calls, 'workspace_id') === WORKSPACE_ID && eqValue(calls, 'state') === 'queued' && eqValue(calls, 'source') === 'upload'
                queued = false
                return { data: moved ? [{ id: 5, upload_bytes: TAR.byteLength }] : [] }
            }
            return undefined
        })
        download.mockImplementation(() => ({ asStream: () => Promise.resolve({ data: new Blob([TAR]).stream(), error: null }) }))
        vi.mocked(createServiceRoleClient).mockReturnValue({ ...db.client, storage: { from: () => ({ download }) } } as never)
    })

    const projectWrites = () => db.writes('factory_projects')

    it('refuses a browser session without the factory key, and moves nothing', async () => {
        const response = await GET(...archiveRequest(null))
        expect(response.status).toBe(401)
        expect(projectWrites()).toEqual([])
        expect(download).not.toHaveBeenCalled()
    })

    it('refuses a key that is not the factory reporter, and an import key, and moves nothing', async () => {
        expect((await GET(...archiveRequest(MEMBER_KEY))).status).toBe(403)
        expect((await GET(...archiveRequest(IMPORT_KEY))).status).toBe(401)
        expect(projectWrites()).toEqual([])
        expect(download).not.toHaveBeenCalled()
    })

    it('streams the object once for a queued upload of the key workspace, then refuses the second fetch', async () => {
        const first = await GET(...archiveRequest(FACTORY_KEY))
        expect(first.status).toBe(200)
        expect(new Uint8Array(await first.arrayBuffer())).toEqual(TAR)
        expect(download).toHaveBeenCalledWith(`${WORKSPACE_ID}/5.tar`)
        expect(projectWrites()[0]).toMatchObject({ method: 'update', payload: { state: 'unpacking' } })

        const second = await GET(...archiveRequest(FACTORY_KEY))
        expect(second.status).toBe(409)
        expect(download).toHaveBeenCalledTimes(1)
    })

    it('refuses an id that is not a positive integer without touching the row', async () => {
        expect((await GET(...archiveRequest(FACTORY_KEY, '0x5'))).status).toBe(404)
        expect(projectWrites()).toEqual([])
    })
})
