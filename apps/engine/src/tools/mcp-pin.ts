import semver from 'semver'
import type { McpServer } from '../agents/types.js'
import { fetchPublic } from '../lib/public-fetch.js'
import { isRegistryExactSpec, parseNpxLaunch } from './mcp-packages.js'

export type StdioPin = { pinned: true; command: string; args: string[] } | { pinned: false }

export class McpVersionUnresolvedError extends Error {
    readonly code = 'mcp_version_unresolved'
    constructor(readonly spec: string) {
        super(`Could not resolve a released version for ${spec}`)
        this.name = 'McpVersionUnresolvedError'
    }
}

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PYPI_SPEC_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[A-Za-z0-9._,-]+\])?(.*)$/
const PEP440_RELEASE_RE = /^\d+(?:\.\d+)*$/

export const mcpLaunchLine = (server: McpServer): string => [server.command ?? '', ...server.args].join(' ').trim()

async function registryJson(url: string, spec: string): Promise<Record<string, unknown>> {
    const res = await fetchPublic(url, { headers: { accept: 'application/json' } }).catch(() => null)
    const doc: unknown = res?.ok ? await res.json().catch(() => null) : null
    if (!doc || typeof doc !== 'object') throw new McpVersionUnresolvedError(spec)
    return doc as Record<string, unknown>
}

async function npmVersion(name: string, selector: string | null, spec: string): Promise<string> {
    const doc = await registryJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, spec)
    const tags = (doc['dist-tags'] ?? {}) as Record<string, string>
    const versions = Object.keys((doc.versions ?? {}) as Record<string, unknown>)
    const wanted = selector === null ? tags.latest : (tags[selector] ?? (semver.validRange(selector) ? semver.maxSatisfying(versions, selector) : null))
    if (!wanted || !semver.valid(wanted) || !versions.includes(wanted)) throw new McpVersionUnresolvedError(spec)
    return wanted
}

function compareRelease(a: string, b: string): number {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

function satisfiesClause(version: string, clause: string): boolean | null {
    const match = /^(~=|===|==|!=|>=|<=|>|<)\s*([0-9.]+)(\.\*)?$/.exec(clause.trim())
    if (!match) return null
    const [, op, target, wildcard] = match as unknown as [string, string, string, string | undefined]
    if (wildcard) {
        if (op !== '==' && op !== '!=') return null
        const prefix = version.split('.').slice(0, target.split('.').length).join('.')
        return (compareRelease(prefix, target) === 0) === (op === '==')
    }
    const cmp = compareRelease(version, target)
    if (op === '~=') {
        const parts = target.split('.')
        if (parts.length < 2) return null
        return cmp >= 0 && compareRelease(version.split('.').slice(0, parts.length - 1).join('.'), parts.slice(0, -1).join('.')) === 0
    }
    return { '==': cmp === 0, '===': version === target, '!=': cmp !== 0, '>=': cmp >= 0, '<=': cmp <= 0, '>': cmp > 0, '<': cmp < 0 }[op] ?? null
}

async function pypiVersion(name: string, specifier: string, spec: string): Promise<string> {
    const doc = await registryJson(`https://pypi.org/pypi/${name}/json`, spec)
    const releases = (doc.releases ?? {}) as Record<string, { yanked?: boolean }[]>
    const available = Object.keys(releases).filter(version => PEP440_RELEASE_RE.test(version) && (releases[version] ?? []).some(file => !file.yanked))
    if (!specifier) {
        const latest = ((doc.info ?? {}) as { version?: string }).version
        if (latest && available.includes(latest)) return latest
        throw new McpVersionUnresolvedError(spec)
    }
    const clauses = specifier.split(',')
    if (clauses.some(clause => satisfiesClause('0', clause) === null)) throw new McpVersionUnresolvedError(spec)
    const best = available.filter(version => clauses.every(clause => satisfiesClause(version, clause))).sort(compareRelease).at(-1)
    if (!best) throw new McpVersionUnresolvedError(spec)
    return best
}

async function pinNpx(server: McpServer): Promise<StdioPin> {
    const launch = parseNpxLaunch(server)
    if (!launch || server.command !== 'npx') return { pinned: false }
    if (isRegistryExactSpec(launch.spec)) return { pinned: true, command: 'npx', args: server.args }
    const at = launch.spec.lastIndexOf('@')
    const name = at > 0 ? launch.spec.slice(0, at) : launch.spec
    if (!NPM_NAME_RE.test(name)) return { pinned: false }
    const version = await npmVersion(name, at > 0 ? launch.spec.slice(at + 1) : null, launch.spec)
    const flags = server.args.slice(0, server.args.length - launch.rest.length - 1)
    return { pinned: true, command: 'npx', args: [...flags, `${name}@${version}`, ...launch.rest] }
}

async function pinUvx(server: McpServer): Promise<StdioPin> {
    const [first, second, third] = server.args
    if (!first) return { pinned: false }
    const fromForm = first === '--from'
    const spec = fromForm ? second : first
    if (!spec || spec.startsWith('-') || (fromForm && (!third || third.startsWith('-')))) return { pinned: false }
    const at = fromForm ? -1 : spec.indexOf('@')
    const bare = at > 0 ? spec.slice(0, at) : spec
    const parsed = PYPI_SPEC_RE.exec(bare)
    if (!parsed) return { pinned: false }
    const [, name, extras = '', rest] = parsed as unknown as [string, string, string | undefined, string]
    if (!fromForm && rest) return { pinned: false }
    const tag = at > 0 ? spec.slice(at + 1) : ''
    const specifier = fromForm ? rest.trim() : tag && tag !== 'latest' ? `==${tag}` : ''
    const version = await pypiVersion(name, specifier, spec)
    const entry = fromForm ? third! : name
    return { pinned: true, command: 'uvx', args: ['--from', `${name}${extras}==${version}`, entry, ...server.args.slice(fromForm ? 3 : 1)] }
}

export async function pinStdioLaunch(server: McpServer): Promise<StdioPin> {
    if (server.command === 'npx') return pinNpx(server)
    if (server.command === 'uvx') return pinUvx(server)
    return { pinned: false }
}
