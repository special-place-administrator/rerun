import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireWorkspaceContext, workspaceFounderUserId } from '@/app/api/_auth/ownership'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { fakeSupabase, type FakeSupabase } from '@/test/supabase-fake'

import { POST } from './route'

vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/app/api/_auth/ownership', async importOriginal => ({
    ...await importOriginal<typeof import('@/app/api/_auth/ownership')>(),
    requireWorkspaceContext: vi.fn(),
    workspaceFounderUserId: vi.fn(),
}))

const WORKSPACE_ID = 7
const OWNER = 'user-owner'
const MEMBER = 'user-member'
const LIMITS = { max_count: 5, max_project_mb: 100, max_total_mb: 500, upload_max_mb: 1, upload_max_files: 1000, upload_max_depth: 32, upload_max_file_mb: 10 }
const BODY = new TextEncoder().encode('a folder packed as tar')

function uploadRequest(body: Uint8Array, length = String(body.byteLength), name = '  My\u0007 app  ') {
    return new Request(`https://hub.test/api/factory/projects/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-length': length }, body, duplex: 'half' } as RequestInit)
}

describe('POST /api/factory/projects/upload', () => {
    let db: FakeSupabase
    let limits: typeof LIMITS | null
    const upload = vi.fn()
    const remove = vi.fn()

    function signIn(userId: string) {
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ userId, workspace: { id: WORKSPACE_ID } } as never)
    }

    beforeEach(() => {
        vi.clearAllMocks()
        limits = LIMITS
        vi.mocked(workspaceFounderUserId).mockResolvedValue(OWNER)
        db = fakeSupabase((table, calls) => {
            if (table === 'workspace_members') return { data: { role: 'admin' } }
            if (table === 'factory_controls') return { data: { project_limits: limits } }
            if (table !== 'factory_projects') return undefined
            const write = calls.find(c => c.method === 'insert' || c.method === 'update')
            if (!write) return { count: 0 }
            return { data: { id: 41, name: 'My app', source: 'upload', repo: null, state: 'uploading', error_code: null, dropped: [], ...(write.args[0] as object) } }
        })
        upload.mockImplementation(async (_path: string, body: ReadableStream) => {
            try {
                await new Response(body).arrayBuffer()
                return { error: null }
            } catch {
                return { error: { message: 'aborted' } }
            }
        })
        remove.mockResolvedValue({ error: null })
        vi.mocked(createServiceRoleClient).mockReturnValue({ ...db.client, storage: { createBucket: vi.fn().mockResolvedValue({}), from: () => ({ upload, remove }) } } as never)
    })

    it('refuses a member who is not the factory owner, and stores nothing', async () => {
        signIn(MEMBER)
        const response = await POST(uploadRequest(BODY))
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: { code: 'owner_only' } })
        expect(db.writes('factory_projects')).toEqual([])
        expect(upload).not.toHaveBeenCalled()
    })

    it('refuses the owner while no project quota is set, and stores nothing', async () => {
        signIn(OWNER)
        limits = null
        const response = await POST(uploadRequest(BODY))
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: { code: 'quota_unset' } })
        expect(db.writes('factory_projects')).toEqual([])
        expect(upload).not.toHaveBeenCalled()
    })

    it('stores the archive at a server-built path and queues the row with its size and sha256', async () => {
        signIn(OWNER)
        const response = await POST(uploadRequest(BODY))
        expect(response.status).toBe(200)
        expect(upload).toHaveBeenCalledWith(`${WORKSPACE_ID}/41.tar`, expect.anything(), expect.objectContaining({ contentType: 'application/x-tar' }))
        const writes = db.writes('factory_projects')
        expect(writes[0].payload).toMatchObject({ workspace_id: WORKSPACE_ID, source: 'upload', state: 'uploading', repo: null, name: 'My app' })
        expect(writes[1].payload).toMatchObject({ state: 'queued', upload_bytes: BODY.byteLength, upload_sha256: createHash('sha256').update(BODY).digest('hex') })
        expect(writes[1].filters.find(c => c.method === 'select')?.args[0]).not.toMatch(/upload_sha256|upload_bytes|host_path/)
        expect((await response.json()).project).toMatchObject({ id: 41, state: 'queued' })
    })

    it('refuses a declared size over the upload limit before any row, and a body longer than declared', async () => {
        signIn(OWNER)
        const big = await POST(uploadRequest(BODY, String(LIMITS.upload_max_mb * 1024 * 1024 + 1)))
        expect(big.status).toBe(413)
        expect(await big.json()).toEqual({ error: { code: 'upload_too_large' } })
        expect(db.writes('factory_projects')).toEqual([])

        const lying = await POST(uploadRequest(BODY, '4'))
        expect(lying.status).toBe(413)
        expect(db.writes('factory_projects').at(-1)?.payload).toMatchObject({ state: 'failed', error_code: 'upload_too_large' })
        expect(remove).toHaveBeenCalledWith([`${WORKSPACE_ID}/41.tar`])
    })
})
