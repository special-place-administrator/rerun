import { describe, expect, it, vi } from 'vitest'

import { AccountToolError, dispatchAccountTool } from '@/app/api/_services/mcp-account.service'
import { authenticateApiKey } from '@/lib/mcp/api-keys'

import { handleAccountMcp } from './account-rpc'

vi.mock('@/app/api/_services/mcp-account.service', async importOriginal => ({ ...(await importOriginal<typeof import('@/app/api/_services/mcp-account.service')>()), dispatchAccountTool: vi.fn() }))
vi.mock('@/app/api/_services/agent.service', () => ({ deleteAgent: vi.fn() }))
vi.mock('@/lib/mcp/api-keys', () => ({ authenticateApiKey: vi.fn(), bindImportKey: vi.fn() }))

async function toolError() {
    vi.mocked(authenticateApiKey).mockResolvedValue({ keyId: 'k1', workspaceId: 'w1', createdByUserId: null } as never)
    const req = new Request('https://hub.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: {} } }) })
    const { result } = await (await handleAccountMcp(req, 'token')).json()
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) }
}

describe('account tool errors', () => {
    it('carries the stable code of an account tool error beside its message', async () => {
        vi.mocked(dispatchAccountTool).mockRejectedValue(new AccountToolError('The coworker could not be reached: 503 x', 'no_usable_connection'))
        expect(await toolError()).toEqual({ isError: true, payload: { error: 'The coworker could not be reached: 503 x', code: 'no_usable_connection' } })
    })

    it('keeps any other error to its message alone', async () => {
        vi.mocked(dispatchAccountTool).mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))
        expect(await toolError()).toEqual({ isError: true, payload: { error: 'boom' } })
    })
})
