import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CUSTOM_BASE_URL_AUTH_KEY } from '@moldwright/contracts'
import { migrate } from '../db/migrate.js'
import { latestVersion } from '../db/ladder.js'
import { foldAgentKeysIntoConnections } from '../connections/migrate.js'
import { EVEROS_ALLOWLIST_DDL } from '../agents/everos-allowlist.js'
import { ensureBusTables } from '../bus/ddl.js'
import { agentsDir, boxPlanPath, codexAuthPath, codexHomeDir, configPath, connectionConfigPath, connectionDir, connectionEnvPath, connectionsDir, isPathSegment, mcpDir, mcpPackagesDir } from '../config/paths.js'
import { raw } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { EVEROS_MCP_SERVER, EVEROS_WRAPPER_COMMAND } from '../tools/mcp-everos.js'
import { parseEnvFile, serializeEnv } from '../lib/env-file.js'

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT'

async function listDirOrEmpty(dir: string): Promise<string[]> {
    try {
        return await readdir(dir)
    } catch (err) {
        if (!isMissing(err)) logger.warn({ dir, err: (err as Error).message }, 'data-dir migration: folder left unread')
        return []
    }
}

async function chmodRegular(path: string, mode: number, kind: 'file' | 'dir'): Promise<void> {
    try {
        const info = await lstat(path)
        if (kind === 'file' ? !info.isFile() : !info.isDirectory()) return
        await chmod(path, mode)
    } catch (err) {
        if (!isMissing(err)) logger.warn({ path, err: (err as Error).message }, 'data-dir migration: mode left as is')
    }
}

async function listAgentFolders(): Promise<string[]> {
    const folders: string[] = []
    for (const name of await listDirOrEmpty(agentsDir())) {
        if (!isPathSegment(name)) continue
        const info = await lstat(resolve(agentsDir(), name)).catch(() => null)
        if (info?.isDirectory()) folders.push(name)
    }
    return folders
}

async function listConnectionFolders(): Promise<string[]> {
    const folders: string[] = []
    for (const name of await listDirOrEmpty(connectionsDir())) {
        if (!isPathSegment(name)) continue
        const info = await lstat(resolve(connectionsDir(), name)).catch(() => null)
        if (info?.isDirectory()) folders.push(name)
    }
    return folders
}

async function writeDurably(path: string, content: string): Promise<void> {
    const tmp = `${path}.migrate.tmp`
    const handle = await open(tmp, 'w', 0o600)
    try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await chmod(tmp, 0o600)
    await rename(tmp, path)
}

function safeDecode(component: string): string {
    return component.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
        try {
            return decodeURIComponent(run)
        } catch {
            return run
        }
    })
}

async function moveBaseUrlCredentials(id: string): Promise<void> {
    const configFile = connectionConfigPath(id)
    if (!existsSync(configFile)) return
    let config: { baseUrl?: unknown }
    try {
        config = JSON.parse(await readFile(configFile, 'utf8')) as { baseUrl?: unknown }
    } catch {
        logger.warn({ connection: id }, 'skipped: unreadable config')
        return
    }
    if (typeof config.baseUrl !== 'string' || !config.baseUrl) return
    let url: URL
    try {
        url = new URL(config.baseUrl)
    } catch {
        return
    }
    if (!url.username && !url.password) return
    const credential = `${safeDecode(url.username)}:${safeDecode(url.password)}`
    const envFile = connectionEnvPath(id)
    const env = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {}
    if (env[CUSTOM_BASE_URL_AUTH_KEY] !== credential) await writeDurably(envFile, serializeEnv({ ...env, [CUSTOM_BASE_URL_AUTH_KEY]: credential }))
    url.username = ''
    url.password = ''
    await writeDurably(configFile, `${JSON.stringify({ ...config, baseUrl: url.toString() }, null, 4)}\n`)
    logger.info({ connection: id }, 'migrated')
}

type RawServer = { name?: unknown; command?: unknown; disabledReason?: unknown; tools?: unknown; env?: unknown }

const isEverosWrapper = (server: unknown): server is RawServer => typeof server === 'object' && server !== null && (server as RawServer).command === EVEROS_WRAPPER_COMMAND

async function moveEverosToDirect(id: string): Promise<void> {
    const file = configPath(id)
    let config: { mcpServers?: unknown }
    try {
        config = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: unknown }
    } catch (err) {
        if (!isMissing(err)) logger.warn({ agent: id, err }, 'everos-direct: config unreadable, skipped')
        return
    }
    if (!Array.isArray(config.mcpServers) || !config.mcpServers.some(isEverosWrapper)) return
    const mcpServers = config.mcpServers.map((server: unknown) => {
        if (!isEverosWrapper(server)) return server
        if (typeof server.env === 'object' && server.env !== null && Object.keys(server.env).length > 0) logger.warn({ agent: id, keys: Object.keys(server.env) }, 'everos-direct: wrapper env dropped')
        return {
            ...EVEROS_MCP_SERVER,
            name: typeof server.name === 'string' ? server.name : EVEROS_MCP_SERVER.name,
            ...(server.disabledReason !== undefined ? { disabledReason: server.disabledReason } : {}),
            ...(server.tools !== undefined ? { tools: server.tools } : {}),
        }
    })
    await writeDurably(file, `${JSON.stringify({ ...config, mcpServers }, null, 4)}\n`)
    logger.info({ agent: id }, 'everos server moved to the direct definition')
}

export type DataDirMigration = { version: number; id: string; up: () => Promise<void> }

export const DATA_DIR_MIGRATIONS: DataDirMigration[] = [
    {
        version: 1,
        id: 'baseline',
        up: async () => {
            await migrate()
            await foldAgentKeysIntoConnections()
        },
    },
    {
        version: 2,
        id: 'box-plan',
        up: async () => {
            const target = boxPlanPath()
            if (existsSync(target)) return
            const tmp = `${target}.tmp`
            await writeFile(tmp, `${JSON.stringify({ premiumModels: true }, null, 4)}\n`, 'utf8')
            await rename(tmp, target)
        },
    },
    {
        version: 3,
        id: 'mcp-packages',
        up: async () => {
            await mkdir(mcpPackagesDir(), { recursive: true })
        },
    },
    {
        version: 4,
        id: 'secret-file-modes',
        up: async () => {
            for (const id of await listAgentFolders()) {
                await chmodRegular(configPath(id), 0o600, 'file')
                const mcp = mcpDir(id)
                for (const name of await listDirOrEmpty(mcp)) {
                    if (name.endsWith('.json')) await chmodRegular(resolve(mcp, name), 0o600, 'file')
                }
                await chmodRegular(mcp, 0o700, 'dir')
            }
        },
    },
    {
        version: 5,
        id: 'connection-file-modes',
        up: async () => {
            for (const id of await listConnectionFolders()) {
                await chmodRegular(connectionDir(id), 0o700, 'dir')
                await chmodRegular(connectionConfigPath(id), 0o600, 'file')
                await chmodRegular(connectionEnvPath(id), 0o600, 'file')
                await chmodRegular(codexHomeDir(id), 0o700, 'dir')
                await chmodRegular(codexAuthPath(id), 0o600, 'file')
                await moveBaseUrlCredentials(id)
            }
        },
    },
    {
        version: 6,
        id: 'everos-direct',
        up: async () => {
            for (const id of await listAgentFolders()) await moveEverosToDirect(id)
        },
    },
    {
        version: 7,
        id: 'everos-shared-allowlist',
        up: async () => {
            await raw().execute(EVEROS_ALLOWLIST_DDL)
        },
    },
    {
        version: 8,
        id: 'bus-tables',
        up: ensureBusTables,
    },
]

export const DATA_DIR_VERSION = latestVersion(DATA_DIR_MIGRATIONS)
