import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from '../config/paths.js'
import { logger } from '../lib/logger.js'

export const EVEROS_WRAPPER_COMMAND = '/data/tools/bin/everos-mcp'

export const EVEROS_MCP_SERVER = {
    name: 'everos',
    transport: 'stdio',
    command: '/data/tools/bin/uv',
    args: ['run', '--quiet', '--python', '3.12', '/data/tools/everos-mcp/server.py'],
    env: {
        EVEROS_URL: '${EVEROS_URL}',
        EVEROS_USER_ID: '${EVEROS_USER_ID}',
        EVEROS_APP: '${EVEROS_APP}',
        EVEROS_TOKEN: '${EVEROS_TOKEN}',
        UV_CACHE_DIR: '/data/tools/uv-cache',
        UV_PYTHON_INSTALL_DIR: '/data/tools/uv-python',
    },
    headers: {},
} as const

export const EVEROS_CLIENT_SOURCE = fileURLToPath(new URL('../../assets/everos-mcp/server.py.shipped', import.meta.url))

export const everosClientPath = () => resolve(dataDir(), 'tools', 'everos-mcp', 'server.py')

export async function refreshEverosClient(): Promise<void> {
    const target = everosClientPath()
    try {
        const shipped = await readFile(EVEROS_CLIENT_SOURCE)
        const current = await readFile(target).catch(() => null)
        if (current?.equals(shipped)) return
        await mkdir(dirname(target), { recursive: true })
        await writeFile(`${target}.image.tmp`, shipped, { mode: 0o644 })
        await rename(`${target}.image.tmp`, target)
        logger.info({ path: target, md5: createHash('md5').update(shipped).digest('hex'), replaced: current !== null }, 'everos client put in place from the image')
    } catch (err) {
        logger.warn({ path: target, err: (err as Error).message }, 'everos client left as is: the image copy was not written')
    }
}
