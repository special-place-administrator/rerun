import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-mcp-enable-'))

const { beforeEach, describe, expect, it, vi } = await import('vitest')

const registry = vi.hoisted(() => ({ responses: new Map<string, unknown>() }))
vi.mock('../../lib/public-fetch.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../lib/public-fetch.js')>()),
    fetchPublic: async (url: string) => {
        const body = registry.responses.get(url)
        return body === undefined ? new Response('not found', { status: 404 }) : Response.json(body)
    },
}))

const { agentRoutes } = await import('./agents.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { readAgentConfig } = await import('../../agents/loader.js')
const { mkdir, writeFile } = await import('node:fs/promises')
const { agentDir } = await import('../../config/paths.js')

const id = 'enableagent'
const disabled = (name: string, command: string, args: string[]) => ({ name, transport: 'stdio', command, args, env: {}, headers: {}, disabledReason: 'stdio_runtime_unpinned' })

const post = (name: string, body: unknown = {}) => agentRoutes.request(`/${id}/mcp-servers/${name}/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const serverNamed = async (name: string) => (await readAgentConfig(id)).mcpServers.find(server => server.name === name)!

beforeEach(async () => {
    registry.responses.clear()
    await mkdir(agentDir(id), { recursive: true })
})

describe('disabled stdio servers and the Enable route', () => {
    it('never spawns a disabled server, reports it without probing, keeps it disabled across PATCH, and pins it on Enable or after an ack', async () => {
        const marker = resolve(process.env.RERUN_DATA_DIR!, 'spawned')
        const { probeMcp } = await import('../../tools/mcp.js')
        const { agentMcpSpawn } = await import('../../tools/mcp-pool.js')
        const planted = disabled('mark', 'sh', ['-c', `touch ${marker}`])
        const config = agentConfigSchema.parse({ name: 'enable', mcpServers: [planted] })
        expect((await probeMcp(id, config.mcpServers[0]!, {}, { spawn: agentMcpSpawn({ id, env: {}, config }) })).ok).toBe(false)
        await writeAgentConfig(id, config)
        expect((await agentRoutes.request(`/${id}/mcp-servers/mark/tools`)).status).not.toBe(200)
        expect(existsSync(marker)).toBe(false)

        const pkg = resolve(process.env.RERUN_DATA_DIR!, 'evil-pkg')
        const installMarker = resolve(process.env.RERUN_DATA_DIR!, 'postinstall-ran')
        await mkdir(resolve(pkg, 'bin'), { recursive: true })
        await writeFile(resolve(pkg, 'package.json'), JSON.stringify({ name: 'evil-mcp', version: '1.0.0', bin: { 'evil-mcp': 'bin/evil.js' }, scripts: { postinstall: `node -e "require('fs').writeFileSync('${installMarker}', '')"` } }))
        await writeFile(resolve(pkg, 'bin/evil.js'), '#!/usr/bin/env node\n')
        const spec = `file:${pkg}`
        const unpinned = agentConfigSchema.parse({ name: 'enable', mcpServers: [disabled('npm', 'npx', ['-y', spec])] })
        await writeAgentConfig(id, unpinned)
        expect((await probeMcp(id, unpinned.mcpServers[0]!, {}, { spawn: agentMcpSpawn({ id, env: {}, config: unpinned }) })).ok).toBe(false)
        expect((await agentRoutes.request(`/${id}/mcp-servers/npm/tools`)).status).not.toBe(200)
        const { installInBackground } = await import('../../tools/mcp-packages.js')
        await installInBackground(spec)
        expect(existsSync(installMarker)).toBe(false)
        expect(existsSync(resolve(pkg, 'node_modules'))).toBe(false)
        await writeAgentConfig(id, agentConfigSchema.parse({ name: 'enable', mcpServers: [disabled('git', 'uvx', ['mcp-server-git', '--repository', '.']), disabled('fs', 'npx', ['-y', '@scope/fs-mcp@^1.2.0']), disabled('py', 'python', ['-m', 'x'])] }))

        const status = await agentRoutes.request(`/${id}/mcp-servers/status?name=git`)
        expect(((await status.json()) as { servers: unknown[] }).servers).toEqual([{ name: 'git', status: 'disabled', code: 'stdio_runtime_unpinned', transport: 'stdio', toolCount: 0 }])

        const patched = await agentRoutes.request(`/${id}/mcp-servers`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upsert: [{ name: 'git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], env: {}, headers: {} }] }) })
        expect(patched.status).toBe(200)
        expect((await serverNamed('git')).disabledReason).toBe('stdio_runtime_unpinned')

        const unresolved = await post('git')
        expect(unresolved.status).toBe(502)
        expect(await unresolved.json()).toMatchObject({ code: 'mcp_version_unresolved', name: 'git', spec: 'mcp-server-git' })
        expect((await serverNamed('git')).disabledReason).toBe('stdio_runtime_unpinned')

        registry.responses.set('https://pypi.org/pypi/mcp-server-git/json', { info: { version: '2026.1.14' }, releases: { '2026.1.14': [{}] } })
        registry.responses.set('https://registry.npmjs.org/@scope%2Ffs-mcp', { 'dist-tags': { latest: '2.0.0' }, versions: { '1.1.9': {}, '1.2.0': {}, '1.4.2': {}, '2.0.0': {} } })
        expect((await post('git')).status).toBe(200)
        expect((await post('fs')).status).toBe(200)
        const git = await serverNamed('git')
        const fs = await serverNamed('fs')
        expect([git.command, git.args, git.disabledReason]).toEqual(['uvx', ['--from', 'mcp-server-git==2026.1.14', 'mcp-server-git'], undefined])
        expect([fs.command, fs.args, fs.disabledReason]).toEqual(['npx', ['-y', '@scope/fs-mcp@1.4.2'], undefined])

        const refused = await post('py')
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ code: 'mcp_enable_needs_ack', name: 'py', command: 'python -m x' })
        expect((await post('py', { acceptUnpinned: true })).status).toBe(200)
        const py = await serverNamed('py')
        expect([py.command, py.args, py.disabledReason]).toEqual(['python', ['-m', 'x'], undefined])
    })
})
