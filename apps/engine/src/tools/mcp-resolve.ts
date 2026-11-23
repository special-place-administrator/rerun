import type { McpServer } from '../agents/types.js'
import { logger } from '../lib/logger.js'

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const ENGINE_ENV_PLACEHOLDERS = new Set(['RERUN_HUB_BASE_URL'])

export class McpEnvRefError extends Error {
    readonly code = 'env_ref_unresolved'
    constructor(
        serverName: string,
        readonly refs: string[],
        readonly refusedKeys: string[] = [],
    ) {
        const needs = refs.length ? `needs ${refs.join(', ')}, which ${refs.length === 1 ? 'is' : 'are'} not set` : ''
        const refused = refusedKeys.length ? `has env ${refusedKeys.join(', ')} in a shape the engine does not pass` : ''
        super(`server "${serverName}" ${[refused, needs].filter(Boolean).join(' and ')}`)
        this.name = 'McpEnvRefError'
    }
}

const lookup = (name: string, env: Record<string, string>): string | undefined => env[name] ?? (ENGINE_ENV_PLACEHOLDERS.has(name) ? process.env[name] : undefined)

export function unsetEnvRefs(values: string[], env: Record<string, string>): string[] {
    const names = values.flatMap(value => [...value.matchAll(PLACEHOLDER)].map(match => match[1]!))
    return [...new Set(names.filter(name => lookup(name, env) === undefined))].sort()
}

function resolveEnvRefs(rec: Record<string, string>, env: Record<string, string>, serverName: string): Record<string, string> {
    const out: Record<string, string> = {}
    const missing = new Set<string>()
    for (const [k, v] of Object.entries(rec))
        out[k] = v.replace(PLACEHOLDER, (_, name: string) => {
            const resolved = env[name] ?? (ENGINE_ENV_PLACEHOLDERS.has(name) ? process.env[name] : undefined)
            if (resolved === undefined) missing.add(name)
            return resolved ?? ''
        })
    if (missing.size > 0) throw new McpEnvRefError(serverName, [...missing].sort())
    return out
}

function resolveValue(value: string, env: Record<string, string>, serverName: string): string {
    return value.replace(PLACEHOLDER, (_, name: string) => {
        const resolved = env[name] ?? (ENGINE_ENV_PLACEHOLDERS.has(name) ? process.env[name] : undefined)
        if (resolved === undefined) {
            logger.warn({ server: serverName, var: name }, 'mcp: unresolved placeholder')
            return ''
        }
        return resolved
    })
}

function resolveRecord(rec: Record<string, string>, env: Record<string, string>, serverName: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = resolveValue(v, env, serverName)
    return out
}

export function resolveServerSecrets(server: McpServer, env: Record<string, string>): McpServer {
    return {
        ...server,
        command: server.command ? resolveValue(server.command, env, server.name) : server.command,
        args: server.args.map(a => resolveValue(a, env, server.name)),
        url: server.url ? resolveValue(server.url, env, server.name) : server.url,
        env: resolveEnvRefs(server.env, env, server.name),
        headers: resolveRecord(server.headers, env, server.name),
    }
}
