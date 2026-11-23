import type { McpServer } from '../agents/types.js'

const KNOWN_PACKAGE_ENV: { matches: (token: string) => boolean; names: string[] }[] = [
    {
        matches: token => /^@modelcontextprotocol\/server-github(@|$)/.test(token) || /(^|\/)github-mcp-server$/.test(token),
        names: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    },
]

export function withKnownEnvRefs(server: McpServer, available: Record<string, string>): McpServer {
    if (!server.command || server.url) return server
    const tokens = [server.command, ...server.args]
    const names = KNOWN_PACKAGE_ENV.filter(entry => tokens.some(entry.matches)).flatMap(entry => entry.names)
    const added = names.filter(name => available[name] !== undefined && server.env[name] === undefined)
    if (added.length === 0) return server
    return { ...server, env: { ...server.env, ...Object.fromEntries(added.map(name => [name, `\${${name}}`])) } }
}
