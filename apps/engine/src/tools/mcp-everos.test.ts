import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-everos-client-'))
process.env.RERUN_DATA_DIR = dataDir

const { describe, expect, it, vi } = await import('vitest')
const { createHash } = await import('node:crypto')
const { mkdir, readFile, rm, stat, writeFile } = await import('node:fs/promises')
const { logger } = await import('../lib/logger.js')
const { EVEROS_CLIENT_SOURCE, EVEROS_MCP_SERVER, everosClientPath } = await import('./mcp-everos.js')
const { prepareDataDir } = await import('../datadir/ladder.js')

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex')

describe('the everos client shipped in the image', () => {
    it('is the accepted v2 client, and every boot puts it where the coworkers run it', async () => {
        const shipped = await readFile(EVEROS_CLIENT_SOURCE)
        expect(md5(shipped)).toBe('991452bb56267226a877982b95787e71')
        expect(everosClientPath()).toBe(resolve(dataDir, 'tools/everos-mcp/server.py'))
        expect(EVEROS_MCP_SERVER.args.at(-1)).toBe('/data/tools/everos-mcp/server.py')

        await prepareDataDir()
        expect(md5(await readFile(everosClientPath()))).toBe(md5(shipped))

        await writeFile(everosClientPath(), '# a hand copy of the v1 client\n')
        await prepareDataDir()
        expect(md5(await readFile(everosClientPath()))).toBe(md5(shipped))

        const kept = (await stat(everosClientPath())).mtimeMs
        await new Promise(done => setTimeout(done, 20))
        await prepareDataDir()
        expect((await stat(everosClientPath())).mtimeMs).toBe(kept)

        await rm(resolve(dataDir, 'tools/everos-mcp'), { recursive: true })
        await mkdir(everosClientPath(), { recursive: true })
        const warn = vi.spyOn(logger, 'warn')
        await prepareDataDir()
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ path: everosClientPath() }), 'everos client left as is: the image copy was not written')
    })
})
