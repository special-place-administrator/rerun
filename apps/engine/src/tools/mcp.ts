import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { outsideAgentDir, spawnSafeEnv, templateRefusedEnvKeys, withEngineOwnedEnv } from '../lib/child-env.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Provider } from '@moldwright/contracts'
import { CLI_PROVIDERS, type LoadedAgent, type McpServer } from '../agents/types.js'
import { agentDir, workspaceDir } from '../config/paths.js'
import { withAuth } from './mcp-auth.js'
import { withHubHeaders } from './mcp-hub-headers.js'
import { withInstalledPackage } from './mcp-packages.js'
import { withKnownEnvRefs } from './mcp-env-refs.js'
import { McpEnvRefError, resolveServerSecrets, unsetEnvRefs } from './mcp-resolve.js'
import { toToolInputSchema } from './mcp-schema.js'
import { logger } from '../lib/logger.js'
import { readSharedEnvSync } from '../agents/shared-env.js'
import { EVEROS_MCP_SERVER } from './mcp-everos.js'
import { isImported } from '../agents/imported.js'

export type McpSpawn = { cwd: string; env: Record<string, string> }
export type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]
export type McpCallResult = Awaited<ReturnType<Client['callTool']>>
export type McpCall = (name: string, args: Record<string, unknown>) => Promise<McpCallResult>
export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpProbe = { ok: boolean; transport: McpTransport; toolNames: string[]; error?: string; code?: 'env_ref_unresolved'; missingEnv?: string[] }

export function mcpToolNameFor(provider: Provider | undefined, serverName: string, toolName: string): string {
    return provider && CLI_PROVIDERS.has(provider) ? `mcp__${serverName}__${toolName}` : `${serverName}_${toolName}`
}

export function resolveTransport(server: McpServer): McpTransport {
    if (server.transport) return server.transport
    if (server.command) return 'stdio'
    if (server.url) return server.url.replace(/\/+$/, '').endsWith('/sse') ? 'sse' : 'http'
    return 'stdio'
}

function buildTransport(server: McpServer, spawn: McpSpawn): Transport | null {
    if (!isEnabledMcpServer(server)) throw new McpServerDisabledError(server.name)
    const kind = resolveTransport(server)
    if (kind === 'stdio') {
        if (!server.command) return null
        const env = withEngineOwnedEnv(spawn.env, server.env)
        return new StdioClientTransport({ command: server.command, args: server.args, env, cwd: spawn.cwd })
    }
    if (!server.url) return null
    const url = new URL(server.url)
    const headers = Object.keys(server.headers).length > 0 ? server.headers : undefined
    if (kind === 'http') return new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined)
    return new SSEClientTransport(url, headers ? { requestInit: { headers } } : undefined)
}

export const MAX_TOOL_PAGES = 50

async function listAllTools(client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; pages < MAX_TOOL_PAGES; pages++) {
        const page = await client.listTools(cursor ? { cursor } : undefined)
        tools.push(...page.tools)
        if (page.tools.length === 0) break
        cursor = page.nextCursor && !seenCursors.has(page.nextCursor) ? page.nextCursor : undefined
        if (!cursor) break
        if (pages === MAX_TOOL_PAGES - 1) {
            logger.warn({ pages: MAX_TOOL_PAGES, tools: tools.length }, 'mcp tool list hit page cap')
        }
        seenCursors.add(cursor)
    }
    return tools
}

export async function openMcpClient(server: McpServer, spawn: McpSpawn): Promise<{ client: Client; tools: McpTool[] }> {
    const transport = buildTransport(server, spawn)
    if (!transport) throw new Error(`server "${server.name}" needs a command (stdio) or a url (sse/http)`)
    const client = new Client({ name: 'rerun-engine', version: '1.0.0' })
    try {
        await client.connect(transport)
        return { client, tools: await listAllTools(client) }
    } catch (e) {
        await client.close().catch(() => {})
        throw e
    }
}

export async function callMcpTool(client: Client, name: string, args: Record<string, unknown>, options?: RequestOptions): Promise<McpCallResult> {
    const result = await client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, options)
    if (!result.isError || result.structuredContent === undefined) return result
    const { structuredContent: _structuredContent, ...error } = result
    return error
}

export function modelReadyMcpTool(serverName: string, tool: McpTool): McpTool {
    const { schema, note } = toToolInputSchema(tool.inputSchema)
    if (schema === tool.inputSchema) return tool
    logger.debug({ server: serverName, tool: tool.name }, 'mcp: tool schema normalised')
    const description = tool.description ?? tool.name
    return { ...tool, description: note ? `${description}\n\n${note}` : description, inputSchema: schema as McpTool['inputSchema'] }
}

export function mcpToolSet(serverName: string, tools: McpTool[], call: McpCall): ToolSet {
    const set: ToolSet = {}
    for (const original of tools) {
        const t = modelReadyMcpTool(serverName, original)
        set[mcpToolNameFor(undefined, serverName, t.name)] = dynamicTool({
            description: t.description ?? t.name,
            inputSchema: jsonSchema(t.inputSchema),
            execute: async args => JSON.stringify((await call(t.name, args as Record<string, unknown>)).content),
        })
    }
    return set
}

export const isEnabledMcpServer = (server: McpServer): boolean => server.disabledReason === undefined

export class McpServerDisabledError extends Error {
    constructor(name: string) {
        super(`server "${name}" is disabled until it is enabled`)
    }
}

const AGENT_ONLY_ENV_KEYS = new Set(['EVEROS_TOKEN'])

const EVEROS_SHARED_KEYS = ['EVEROS_URL', 'EVEROS_USER_ID', 'EVEROS_APP', 'EVEROS_TOKEN']

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === ''

const withoutBlankAgentOnly = (env: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(env).filter(([key, value]) => !(AGENT_ONLY_ENV_KEYS.has(key) && isBlank(value))))

const isEverosServer = (server: McpServer): boolean =>
    resolveTransport(server) === 'stdio' && server.url === undefined && server.command === EVEROS_MCP_SERVER.command && JSON.stringify(server.args) === JSON.stringify(EVEROS_MCP_SERVER.args)

function mcpInputs(agentId: string, server: McpServer, env: Record<string, string>): { server: McpServer; resolvable: Record<string, string> } {
    const shared = readSharedEnvSync()
    const own = withoutBlankAgentOnly(env)
    const resolvable = { ...withoutBlankAgentOnly(Object.fromEntries(Object.entries(shared).filter(([key]) => !AGENT_ONLY_ENV_KEYS.has(key)))), ...own, RERUN_WORKSPACE: workspaceDir(agentId) }
    if (own.EVEROS_TOKEN !== undefined || isBlank(shared.EVEROS_TOKEN) || !isEverosServer(server) || isImported(agentId)) return { server, resolvable }
    const kept = Object.fromEntries(Object.entries(resolvable).filter(([key]) => !EVEROS_SHARED_KEYS.includes(key)))
    const fromShared = Object.fromEntries(EVEROS_SHARED_KEYS.flatMap(key => (shared[key] === undefined ? [] : [[key, shared[key]!]])))
    return { server: { ...server, env: { ...EVEROS_MCP_SERVER.env }, headers: {} }, resolvable: { ...kept, ...fromShared } }
}

export function missingMcpEnv(agentId: string, server: McpServer, env: Record<string, string>): string[] {
    const inputs = mcpInputs(agentId, server, env)
    return unsetEnvRefs(Object.values(withKnownEnvRefs(inputs.server, inputs.resolvable).env), inputs.resolvable)
}

export async function prepareMcpServer(agentId: string, server: McpServer, env: Record<string, string>, hubAgentId = agentId): Promise<McpServer> {
    if (!isEnabledMcpServer(server)) throw new McpServerDisabledError(server.name)
    const inputs = mcpInputs(agentId, server, env)
    const resolvable = inputs.resolvable
    const known = withKnownEnvRefs(await withAuth(agentId, inputs.server), resolvable)
    const declared = { ...known, env: spawnSafeEnv(known.env) }
    const refused = templateRefusedEnvKeys(known.env)
    if (refused.length) throw new McpEnvRefError(server.name, unsetEnvRefs([...refused.map(key => known.env[key]!), ...Object.values(declared.env)], resolvable), refused)
    const prepared = await withInstalledPackage(withHubHeaders(resolveServerSecrets(declared, resolvable), hubAgentId))
    const allowed = Object.fromEntries(Object.entries(prepared.env).filter(([key]) => Object.hasOwn(declared.env, key)))
    return { ...prepared, env: outsideAgentDir(allowed, agentDir(agentId)) }
}

export class McpProbeTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`no answer within ${Math.round(timeoutMs / 1000)}s`)
    }
}

async function withDeadline<T extends { client: Client }>(opening: Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (timeoutMs === undefined) return opening
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpProbeTimeoutError(timeoutMs)), timeoutMs)
    })
    try {
        return await Promise.race([opening, deadline])
    } catch (e) {
        if (e instanceof McpProbeTimeoutError) opening.then(({ client }) => client.close()).catch(() => {})
        throw e
    } finally {
        clearTimeout(timer)
    }
}

function probeErrorMessage(e: unknown): string {
    const message = (e as Error).message
    const code = (e as { code?: unknown }).code
    return typeof code === 'number' && code >= 400 && !message.includes(String(code)) ? `${message.trimEnd()} (HTTP ${code})` : message
}

export async function probeMcp(agentId: string, server: McpServer, env: Record<string, string>, opts: { spawn: McpSpawn; timeoutMs?: number }): Promise<McpProbe> {
    const transport = resolveTransport(server)
    if (!isEnabledMcpServer(server)) return { ok: false, transport, toolNames: [], error: new McpServerDisabledError(server.name).message }
    try {
        const opening = prepareMcpServer(agentId, server, env).then(prepared => openMcpClient(prepared, opts.spawn))
        const { client, tools } = await withDeadline(opening, opts.timeoutMs)
        const toolNames = tools.map(t => t.name)
        await client.close().catch(() => {})
        return { ok: true, transport, toolNames }
    } catch (e) {
        if (e instanceof McpEnvRefError) return { ok: false, transport, toolNames: [], error: e.message, code: e.code, missingEnv: e.refs }
        return { ok: false, transport, toolNames: [], error: probeErrorMessage(e) }
    }
}
