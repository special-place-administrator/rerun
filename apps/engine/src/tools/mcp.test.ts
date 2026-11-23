import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-mcp-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_LOG_LEVEL = 'fatal'
process.env.RERUN_HUB_BASE_URL = 'https://hub.example'

type FakeTransport = { kind: 'stdio' | 'sse' | 'http'; target: string; options: unknown }
type FakeTool = { name: string; description?: string; inputSchema?: unknown }
type Behaviour = { connectError?: string; connectCode?: number; closeError?: string; hang?: boolean; tools?: FakeTool[]; pages?: Record<string, { tools: FakeTool[]; nextCursor?: string }>; endless?: 'empty' | 'full'; listed?: number }

const mcp = vi.hoisted(() => ({
    transports: [] as FakeTransport[],
    behaviours: new Map<string, Behaviour>(),
    calls: [] as Array<{ target: string; name: string; arguments: unknown }>,
    closed: [] as string[],
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class {
        constructor(options: { command: string }) {
            Object.assign(this, { kind: 'stdio', target: options.command, options })
            mcp.transports.push(this as unknown as FakeTransport)
        }
    },
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: class {
        constructor(url: URL, options: unknown) {
            Object.assign(this, { kind: 'sse', target: url.href, options })
            mcp.transports.push(this as unknown as FakeTransport)
        }
    },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: class {
        constructor(url: URL, options: unknown) {
            Object.assign(this, { kind: 'http', target: url.href, options })
            mcp.transports.push(this as unknown as FakeTransport)
        }
    },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        target = ''
        async connect(transport: FakeTransport) {
            this.target = transport.target
            const behaviour = mcp.behaviours.get(this.target)
            if (behaviour?.hang) await new Promise(resolve => setTimeout(resolve, 50))
            if (behaviour?.connectError) throw Object.assign(new Error(behaviour.connectError), behaviour.connectCode ? { code: behaviour.connectCode } : {})
        }
        async listTools(params?: { cursor?: string }) {
            const behaviour = mcp.behaviours.get(this.target)
            if (behaviour?.endless) {
                behaviour.listed = (behaviour.listed ?? 0) + 1
                const n = behaviour.listed
                return { tools: behaviour.endless === 'full' ? [{ name: `t${n}` }] : [], nextCursor: `page-${n}` }
            }
            if (behaviour?.pages) return behaviour.pages[params?.cursor ?? '']!
            return { tools: behaviour?.tools ?? [] }
        }
        async request({ params }: { params: { name: string; arguments: unknown } }) {
            mcp.calls.push({ target: this.target, ...params })
            return { content: [{ type: 'text', text: `${params.name} ran` }] }
        }
        async close() {
            mcp.closed.push(this.target)
            const error = mcp.behaviours.get(this.target)?.closeError
            if (error) throw new Error(error)
        }
    },
}))

const { beforeEach, describe, expect, it } = await import('vitest')
const { probeMcp, resolveTransport, MAX_TOOL_PAGES } = await import('./mcp.js')
const { closeAllMcp, pooledMcpServers, pooledMcpToolSet } = await import('./mcp-pool.js')
const { dataDir, workspaceDir } = await import('../config/paths.js')

type Server = Parameters<typeof resolveTransport>[0]

function server(overrides: Partial<Server>): Server {
    return { name: 'srv', args: [], env: {}, headers: {}, ...overrides }
}

function agentWith(servers: Server[], env: Record<string, string> = {}) {
    return { id: 'mcp-agent', env, config: { mcpServers: servers, tools: {} } } as any
}

const pooledMcpTools = async (agent: Parameters<typeof pooledMcpServers>[0]) => pooledMcpToolSet(await pooledMcpServers(agent))

beforeEach(async () => {
    closeAllMcp()
    await new Promise(resolve => setTimeout(resolve, 0))
    mcp.transports.length = 0
    mcp.behaviours.clear()
    mcp.calls.length = 0
    mcp.closed.length = 0
})

describe('resolveTransport', () => {
    it.each([
        [{ transport: 'sse', url: 'https://x.io/mcp' }, 'sse'],
        [{ transport: 'http', command: 'npx' }, 'http'],
        [{ command: 'npx', url: 'https://x.io/sse' }, 'stdio'],
        [{ url: 'https://x.io/sse' }, 'sse'],
        [{ url: 'https://x.io/sse///' }, 'sse'],
        [{ url: 'https://x.io/mcp' }, 'http'],
        [{ url: 'https://x.io/sse/extra' }, 'http'],
        [{}, 'stdio'],
    ] as const)('resolves %j to %s', (overrides, expected) => {
        expect(resolveTransport(server(overrides))).toBe(expected)
    })
})

describe('pooled MCP tools', () => {
    it('exposes each tool as <server>_<tool> and runs it through the client', async () => {
        mcp.behaviours.set('https://gh.example/mcp', {
            tools: [{ name: 'search', description: 'Search issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'ping' }],
        })
        const tools = await pooledMcpTools(agentWith([server({ name: 'gh', url: 'https://gh.example/mcp' })]))

        expect(Object.keys(tools)).toEqual(['gh_search', 'gh_ping'])
        expect(tools.gh_search.description).toBe('Search issues')
        expect(tools.gh_ping.description).toBe('ping')
        expect((tools.gh_ping.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual({ type: 'object' })

        const result = await (tools.gh_search as any).execute({ q: 'bug' }, { toolCallId: 'c', messages: [] })
        expect(result).toBe(JSON.stringify([{ type: 'text', text: 'search ran' }]))
        expect(mcp.calls).toEqual([{ target: 'https://gh.example/mcp', name: 'search', arguments: { q: 'bug' } }])
    })

    it('lifts a root oneOf out of a tool schema and tells the model the rule it carried', async () => {
        mcp.behaviours.set('https://tt.example/mcp', {
            tools: [
                {
                    name: 'scan_ad',
                    description: 'Deep-scan an ad',
                    inputSchema: { type: 'object', properties: { ad_identifier: { type: 'string' }, collation_id: { type: 'string' } }, oneOf: [{ required: ['ad_identifier'] }, { required: ['collation_id'] }] },
                },
            ],
        })
        const tools = await pooledMcpTools(agentWith([server({ name: 'tt', url: 'https://tt.example/mcp' })]))

        expect(tools.tt_scan_ad.description).toBe('Deep-scan an ad\n\nProvide exactly one of: ad_identifier, collation_id.')
        expect((tools.tt_scan_ad.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual({
            type: 'object',
            properties: { ad_identifier: { type: 'string' }, collation_id: { type: 'string' } },
        })
    })

    it('drops a server that fails to connect and one with neither command nor url, keeping the others', async () => {
        mcp.behaviours.set('https://down.example/mcp', { connectError: 'ECONNREFUSED' })
        mcp.behaviours.set('https://up.example/mcp', { tools: [{ name: 'list' }] })
        const tools = await pooledMcpTools(
            agentWith([server({ name: 'down', url: 'https://down.example/mcp' }), server({ name: 'empty' }), server({ name: 'up', url: 'https://up.example/mcp' })]),
        )
        expect(Object.keys(tools)).toEqual(['up_list'])
    })

    it('closes every pooled client and swallows a close failure', async () => {
        mcp.behaviours.set('https://a.example/mcp', { tools: [], closeError: 'already closed' })
        mcp.behaviours.set('https://b.example/mcp', { tools: [] })
        await pooledMcpTools(agentWith([server({ name: 'a', url: 'https://a.example/mcp' }), server({ name: 'b', url: 'https://b.example/mcp' })]))
        closeAllMcp()
        await vi.waitFor(() => expect(mcp.closed.sort()).toEqual(['https://a.example/mcp', 'https://b.example/mcp']))
    })

    it('returns no tools for an agent without servers', async () => {
        expect(await pooledMcpTools(agentWith([]))).toEqual({})
    })

    it('hands back the servers that answered with their tool lists, in the order the agent declares them', async () => {
        mcp.behaviours.set('https://down.example/mcp', { connectError: 'ECONNREFUSED' })
        mcp.behaviours.set('https://b.example/mcp', { tools: [{ name: 'list', description: 'List things' }] })
        mcp.behaviours.set('https://a.example/mcp', { tools: [{ name: 'ping' }, { name: 'pong' }] })
        const servers = await pooledMcpServers(
            agentWith([server({ name: 'b', url: 'https://b.example/mcp' }), server({ name: 'down', url: 'https://down.example/mcp' }), server({ name: 'a', url: 'https://a.example/mcp' })]),
        )
        expect(servers.map(pooled => [pooled.name, pooled.tools.map(tool => tool.name)])).toEqual([
            ['b', ['list']],
            ['a', ['ping', 'pong']],
        ])
    })

    it('resolves ${VAR} placeholders from the agent env before dialing', async () => {
        await pooledMcpTools(agentWith([server({ name: 'lin', url: 'https://lin.example/mcp', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } })], { LINEAR_KEY: 'k1' }))
        expect(mcp.transports[0]).toMatchObject({ kind: 'http', target: 'https://lin.example/mcp', options: { requestInit: { headers: { Authorization: 'Bearer k1' } } } })
    })

    it('builds each transport with its own options, a stdio server in its engine-owned directory', async () => {
        process.env.MCP_TEST_INHERITED = 'yes'
        await pooledMcpTools(
            agentWith(
                [
                    server({ name: 'local', command: 'node', args: ['srv.js'], env: { TOKEN: '${LOCAL_TOKEN}', npm_config_registry: '${LOCAL_TOKEN}' } }),
                    server({ name: 'stream', url: 'https://s.example/sse' }),
                    server({ name: 'plain', url: 'https://p.example/mcp' }),
                    server({ name: 'forced', transport: 'sse', url: 'https://f.example/events', headers: { 'x-k': 'v' } }),
                    JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../deploy/vps/everos-mcp.json'), 'utf8')),
                    server({ name: 'keyed', command: 'keyed-mcp', env: { API_KEY: '${SECRET_X}' } }),
                ],
                { LOCAL_TOKEN: 't', SECRET_X: 'sx-1', OTHER_SECRET: 'o', AGENT_KEY: 'a', EVEROS_URL: 'https://everos.lan', EVEROS_USER_ID: 'u', EVEROS_APP: 'app', EVEROS_TOKEN: 'tok' },
            ),
        )
        const byTarget = Object.fromEntries(mcp.transports.map(t => [t.target, t]))
        const stdio = byTarget.node.options as { command: string; args: string[]; env: Record<string, string>; cwd: string }
        expect(stdio.args).toEqual(['srv.js'])
        expect(stdio.cwd).toBe(resolve(dataDir(), 'mcp-cwd', 'mcp-agent'))
        expect(stdio.env.AGENT_KEY).toBeUndefined()
        expect(stdio.env).toMatchObject({ TOKEN: 't', PATH: process.env.PATH, HOME: process.env.HOME, RERUN_WORKSPACE: workspaceDir('mcp-agent') })
        expect(stdio.env.MCP_TEST_INHERITED).toBeUndefined()
        expect(stdio.env).not.toHaveProperty('npm_config_registry')
        expect([stdio.env.NPM_CONFIG_GLOBALCONFIG, stdio.env.NPM_CONFIG_USERCONFIG].map(file => readFileSync(file!, 'utf8'))).toEqual(['', ''])
        expect(stdio.env).not.toHaveProperty('RERUN_API_KEY')
        expect(stdio.env).not.toHaveProperty('RERUN_DATA_DIR')
        expect((byTarget['/data/tools/bin/uv'].options as { env: Record<string, string> }).env).toMatchObject({ UV_CACHE_DIR: '/data/tools/uv-cache', UV_PYTHON_INSTALL_DIR: '/data/tools/uv-python', EVEROS_URL: 'https://everos.lan', EVEROS_TOKEN: 'tok' })
        const keyed = (byTarget['keyed-mcp'].options as { env: Record<string, string> }).env
        expect([keyed.API_KEY, keyed.SECRET_X, keyed.OTHER_SECRET]).toEqual(['sx-1', undefined, undefined])
        expect(byTarget['https://s.example/sse']).toMatchObject({ kind: 'sse', options: undefined })
        expect(byTarget['https://p.example/mcp']).toMatchObject({ kind: 'http', options: undefined })
        expect(byTarget['https://f.example/events']).toMatchObject({ kind: 'sse', options: { requestInit: { headers: { 'x-k': 'v' } } } })
    })

    it('fails a server forced to a transport it has no endpoint for', async () => {
        const tools = await pooledMcpTools(agentWith([server({ name: 'odd', transport: 'http', command: 'npx' }), server({ name: 'odd2', transport: 'stdio', url: 'https://x.io/mcp' })]))
        expect(tools).toEqual({})
        expect(mcp.transports).toHaveLength(0)
    })

    it('dials a hub app as the coworker that delegated, not as the delegate', async () => {
        const gmail = server({ name: 'gmail', url: 'https://hub.example/api/mcp/composio/gmail' })
        await pooledMcpTools({ ...agentWith([gmail]), id: 'delegate-1', hubAgentId: 'boss' })
        expect(mcp.transports[0]).toMatchObject({ target: 'https://hub.example/api/mcp/composio/gmail', options: { requestInit: { headers: { 'x-rerun-agent': 'boss' } } } })
    })

    it('dials a hub app under its own id when it acts for nobody else', async () => {
        await pooledMcpTools(agentWith([server({ name: 'gmail', url: 'https://hub.example/api/mcp/composio/gmail' })]))
        expect(mcp.transports[0]).toMatchObject({ options: { requestInit: { headers: { 'x-rerun-agent': 'mcp-agent' } } } })
    })
})

const spawn = { cwd: '/agents/mcp-agent/workspace', env: { PATH: '/usr/bin', AGENT_KEY: 'a' } }

describe('probeMcp', () => {
    const everosShared = { EVEROS_URL: 'https://everos.lan', EVEROS_USER_ID: 'default', EVEROS_APP: 'rerun' }
    const everosServer = () => server(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../deploy/vps/everos-mcp.json'), 'utf8')))

    it("gives the everos server the agent's own EVEROS_TOKEN over the shared one", async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        await probeMcp('mcp-agent', everosServer(), { EVEROS_TOKEN: 'ui-token' }, { spawn })
        expect((mcp.transports.at(-1)!.options as { env: Record<string, string> }).env.EVEROS_TOKEN).toBe('ui-token')
        await writeSharedEnv({})
    })

    it('falls back to the shared EVEROS_TOKEN for the everos server when the agent has none, and gives a config error when neither has one', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        expect(classifyProbe('everos', await probeMcp('mcp-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'connected' })
        expect((mcp.transports.at(-1)!.options as { env: Record<string, string> }).env.EVEROS_TOKEN).toBe('shared-token')
        await writeSharedEnv(everosShared)
        expect(classifyProbe('everos', await probeMcp('mcp-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'config_error', code: 'env_ref_unresolved', missingEnv: ['EVEROS_TOKEN'] })
        await writeSharedEnv({})
    })

    it('keeps the shared EVEROS_TOKEN from every other server, even one named everos', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        for (const other of [server({ name: 'other', command: 'npx', args: ['some-mcp'], env: { EVEROS_TOKEN: '${EVEROS_TOKEN}' } }), { ...everosServer(), command: '/usr/bin/python3' }])
            expect(classifyProbe(other.name, await probeMcp('mcp-agent', other, {}, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        await writeSharedEnv({})
    })

    const lastEnv = () => (mcp.transports.at(-1)!.options as { env: Record<string, string> }).env

    it('never lets the shared EVEROS_TOKEN into an http server that copies the everos command', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        const spoof = { ...everosServer(), transport: 'http' as const, url: 'https://attacker.invalid/mcp', headers: { Authorization: 'Bearer ${EVEROS_TOKEN}' } }
        await probeMcp('mcp-agent', spoof, {}, { spawn })
        expect(JSON.stringify(mcp.transports)).not.toContain('shared-token')
        await writeSharedEnv({})
    })

    it('passes only the fixed everos env when the shared token is inherited', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        const everos = everosServer()
        await probeMcp('mcp-agent', { ...everos, env: { ...everos.env, UV_DEFAULT_INDEX: '${UDI}' } }, { UDI: 'https://index.invalid/simple' }, { spawn })
        expect(lastEnv().EVEROS_TOKEN).toBe('shared-token')
        expect(lastEnv().UV_DEFAULT_INDEX).toBeUndefined()
        await writeSharedEnv({})
    })

    it('sends the inherited token only to the shared EverOS, and never to an imported agent', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        const { markImported } = await import('../agents/imported.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        await probeMcp('mcp-agent', everosServer(), { EVEROS_URL: 'https://attacker.invalid/everos', EVEROS_USER_ID: 'victim', EVEROS_APP: 'other' }, { spawn })
        expect([lastEnv().EVEROS_URL, lastEnv().EVEROS_USER_ID, lastEnv().EVEROS_APP, lastEnv().EVEROS_TOKEN]).toEqual(['https://everos.lan', 'default', 'rerun', 'shared-token'])
        await markImported('mcp-imported')
        expect(classifyProbe('everos', await probeMcp('mcp-imported', everosServer(), {}, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        await writeSharedEnv({})
    })

    it('refuses the shared token for a delegate of an unallowlisted Boss, and grants it after the Boss is confirmed', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        const childOpts = { spawn, hubAgentId: 'unconfirmed-boss' } as Parameters<typeof probeMcp>[3] & { hubAgentId: string }
        expect(classifyProbe('everos', await probeMcp('delegate-child', everosServer(), {}, childOpts))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        const { allowAgent } = await import('../agents/everos-allowlist.js')
        await allowAgent('unconfirmed-boss', 'confirm')
        expect(classifyProbe('everos', await probeMcp('delegate-child', everosServer(), {}, childOpts))).toMatchObject({ status: 'connected' })
        expect(lastEnv().EVEROS_TOKEN).toBe('shared-token')
        await writeSharedEnv({})
    })

    it('still refuses the shared token after an import marker file is removed', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        const { mkdir, writeFile, rm } = await import('node:fs/promises')
        const { resolve } = await import('node:path')
        const { dataDir } = await import('../config/paths.js')
        const marker = resolve(dataDir(), 'imported-agents', 'tamper-agent')
        await mkdir(resolve(dataDir(), 'imported-agents'), { recursive: true })
        await writeFile(marker, '')
        await rm(marker, { force: true })
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        expect(classifyProbe('everos', await probeMcp('tamper-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        await writeSharedEnv({})
    })

    it('refuses the shared token for a pre-version agent until the operator confirms it', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        expect(classifyProbe('everos', await probeMcp('legacy-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        const { allowAgent } = await import('../agents/everos-allowlist.js')
        await allowAgent('legacy-agent', 'confirm')
        expect(classifyProbe('everos', await probeMcp('legacy-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'connected' })
        expect(lastEnv().EVEROS_TOKEN).toBe('shared-token')
        await writeSharedEnv({})
    })

    it('fails closed with config_error EVEROS_TOKEN when the allowlist store is unreadable', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        const { allowAgent, isAllowlisted } = await import('../agents/everos-allowlist.js')
        await allowAgent('readable-agent', 'create')
        expect(await isAllowlisted('readable-agent')).toBe(true)
        const { raw } = await import('../db/client.js')
        const real = raw().execute.bind(raw())
        const execute = async (arg: unknown) => {
            const sql = typeof arg === 'string' ? arg : (arg as { sql?: string }).sql ?? ''
            if (sql.includes('everos_shared_allowlist') && sql.includes('SELECT')) throw new Error('store unreadable')
            return real(arg as never)
        }
        const spy = (await import('vitest')).vi.spyOn(raw(), 'execute').mockImplementation(execute as never)
        try {
            await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
            expect(classifyProbe('everos', await probeMcp('readable-agent', everosServer(), {}, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        } finally {
            spy.mockRestore()
            await writeSharedEnv({})
        }
    })

    it('counts an empty or blank token as missing, for the own key and the shared one', async () => {
        const { writeSharedEnv } = await import('../agents/shared-env.js')
        const { classifyProbe } = await import('./mcp-status.js')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: 'shared-token' })
        await probeMcp('mcp-agent', everosServer(), { EVEROS_TOKEN: '  ' }, { spawn })
        expect(lastEnv().EVEROS_TOKEN).toBe('shared-token')
        await writeSharedEnv({ ...everosShared, EVEROS_TOKEN: ' ' })
        expect(classifyProbe('everos', await probeMcp('mcp-agent', everosServer(), { EVEROS_TOKEN: '' }, { spawn }))).toMatchObject({ status: 'config_error', missingEnv: ['EVEROS_TOKEN'] })
        await writeSharedEnv({})
    })

    it('dials a stdio server in the agent workspace with the spawn env, never the engine one', async () => {
        process.env.MCP_TEST_INHERITED = 'yes'
        await probeMcp('mcp-agent', server({ name: 'local', command: 'node', args: ['srv.js'], env: { TOKEN: '${LOCAL_TOKEN}', AUTH: 'Bearer ${LOCAL_TOKEN}', LITERAL: 'x', FALCON_BASE_URL: 'https://falcon.example', ANTHROPIC_BASE_URL: '${LOCAL_TOKEN}' } }), { LOCAL_TOKEN: 't' }, { spawn })
        const options = mcp.transports[0]!.options as { env: Record<string, string>; cwd?: string }
        expect(Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith('NPM_CONFIG_')))).toEqual({ PATH: '/usr/bin', AGENT_KEY: 'a', TOKEN: 't', AUTH: 'Bearer t' })
        expect(options.cwd).toBe('/agents/mcp-agent/workspace')
    })

    it('keeps the engine PATH and HOME and drops loader keys whatever an imported server or agent .env sets', async () => {
        const { childProcessEnv } = await import('../lib/child-env.js')
        const archive = { PATH: '/data/agents/x/workspace:/usr/bin', HOME: '/data/agents/x/workspace', NODE_PATH: '/w', NODE_OPTIONS: '--require /w/x.js', PYTHONPATH: '/data/agents/x/workspace/lib', GIT_CONFIG_GLOBAL: '/w/gitconfig', LD_PRELOAD: '/w/x.so', TOKEN: 't' }
        await probeMcp('mcp-agent', server({ name: 'archive-npx', command: 'npx', args: ['-y', '@scope/pkg@1.0.0'], env: archive }), {}, { spawn: { cwd: spawn.cwd, env: { PATH: '/usr/bin', HOME: '/home/engine', RERUN_WORKSPACE: '/data/agents/x/workspace' } } })
        expect((mcp.transports.at(-1)!.options as { env: Record<string, string> }).env).toEqual({ PATH: '/usr/bin', HOME: '/home/engine', RERUN_WORKSPACE: '/data/agents/x/workspace', NPM_CONFIG_GLOBALCONFIG: expect.any(String), NPM_CONFIG_USERCONFIG: expect.any(String) })
        const shellEnv = childProcessEnv(archive)
        expect([shellEnv.PATH, shellEnv.HOME, shellEnv.NODE_OPTIONS, shellEnv.PYTHONPATH, shellEnv.GIT_CONFIG_GLOBAL, shellEnv.TOKEN]).toEqual([process.env.PATH, process.env.HOME, undefined, undefined, undefined, 't'])
    })

    it('lists the tool names and closes the client even when close fails', async () => {
        mcp.behaviours.set('https://ok.example/mcp', { tools: [{ name: 'a' }, { name: 'b' }], closeError: 'boom' })
        expect(await probeMcp('mcp-agent', server({ name: 'ok', url: 'https://ok.example/mcp' }), {}, { spawn })).toEqual({ ok: true, transport: 'http', toolNames: ['a', 'b'] })
        expect(mcp.closed).toEqual(['https://ok.example/mcp'])
    })

    it('reads every page of a server that splits its tool list', async () => {
        mcp.behaviours.set('https://paged.example/mcp', {
            pages: {
                '': { tools: [{ name: 'agents_list' }], nextCursor: 'p2' },
                p2: { tools: [{ name: 'account_get_usage' }], nextCursor: 'p3' },
                p3: { tools: [{ name: 'creative_generate_speech' }, { name: 'creative_list_voices' }] },
            },
        })
        expect((await probeMcp('mcp-agent', server({ name: 'paged', url: 'https://paged.example/mcp' }), {}, { spawn })).toolNames).toEqual(['agents_list', 'account_get_usage', 'creative_generate_speech', 'creative_list_voices'])
    })

    it('stops reading when a server hands back a cursor it already gave', async () => {
        mcp.behaviours.set('https://looping.example/mcp', {
            pages: {
                '': { tools: [{ name: 'a' }], nextCursor: 'again' },
                again: { tools: [{ name: 'b' }], nextCursor: 'again' },
            },
        })
        expect((await probeMcp('mcp-agent', server({ name: 'looping', url: 'https://looping.example/mcp' }), {}, { spawn })).toolNames).toEqual(['a', 'b'])
    })

    it('stops at an empty page even when the server keeps handing out new cursors', async () => {
        const behaviour = { endless: 'empty' as const }
        mcp.behaviours.set('https://endless-empty.example/mcp', behaviour)
        expect((await probeMcp('mcp-agent', server({ name: 'endless', url: 'https://endless-empty.example/mcp' }), {}, { spawn })).toolNames).toEqual([])
        expect(behaviour).toMatchObject({ listed: 1 })
    })

    it('stops after a fixed number of pages when every page brings a new cursor and tools', async () => {
        const behaviour = { endless: 'full' as const }
        mcp.behaviours.set('https://endless-full.example/mcp', behaviour)
        const names = (await probeMcp('mcp-agent', server({ name: 'endless', url: 'https://endless-full.example/mcp' }), {}, { spawn })).toolNames
        expect(names).toHaveLength(MAX_TOOL_PAGES)
        expect(behaviour).toMatchObject({ listed: MAX_TOOL_PAGES })
    })

    it('reports the connection error with the transport it tried', async () => {
        mcp.behaviours.set('https://no.example/sse', { connectError: 'HTTP 401 Unauthorized' })
        expect(await probeMcp('mcp-agent', server({ name: 'no', url: 'https://no.example/sse' }), {}, { spawn })).toEqual({ ok: false, transport: 'sse', toolNames: [], error: 'HTTP 401 Unauthorized' })
    })

    it('closes the client of a server that fails during the handshake', async () => {
        mcp.behaviours.set('https://half.example/mcp', { connectError: 'HTTP 500' })
        await probeMcp('mcp-agent', server({ name: 'half', url: 'https://half.example/mcp' }), {}, { spawn })
        expect(mcp.closed).toEqual(['https://half.example/mcp'])
    })

    it('gives up on a server that does not answer within the deadline, and closes it once it does', async () => {
        mcp.behaviours.set('https://slow.example/mcp', { hang: true, tools: [{ name: 'a' }] })
        expect(await probeMcp('mcp-agent', server({ name: 'slow', url: 'https://slow.example/mcp' }), {}, { spawn, timeoutMs: 5 })).toEqual({
            ok: false,
            transport: 'http',
            toolNames: [],
            error: 'no answer within 0s',
        })
        await vi.waitFor(() => expect(mcp.closed).toEqual(['https://slow.example/mcp']))
    })

    it('names the HTTP status the SDK keeps out of its message, so a bare 401 reads as a sign-in', async () => {
        mcp.behaviours.set('https://linear.example/mcp', { connectError: 'Streamable HTTP error: Error POSTing to endpoint: ', connectCode: 401 })
        expect((await probeMcp('mcp-agent', server({ name: 'linear', url: 'https://linear.example/mcp' }), {}, { spawn })).error).toBe('Streamable HTTP error: Error POSTing to endpoint: (HTTP 401)')
    })

    it('reports a server with nothing to dial', async () => {
        expect(await probeMcp('mcp-agent', server({ name: 'bare' }), {}, { spawn })).toEqual({
            ok: false,
            transport: 'stdio',
            toolNames: [],
            error: 'server "bare" needs a command (stdio) or a url (sse/http)',
        })
    })
})
