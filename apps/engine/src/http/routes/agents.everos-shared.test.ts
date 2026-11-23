import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-agents-everos-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_INSECURE_NO_AUTH = '1'
process.env.RERUN_HUB_BASE_URL = ''

const { describe, expect, it, beforeAll } = await import('vitest')
const { createServer } = await import('../server.js')
const { migrate } = await import('../../db/migrate.js')
const { isAllowlisted } = await import('../../agents/everos-allowlist.js')
const { mkdir, writeFile } = await import('node:fs/promises')
const { agentDir } = await import('../../config/paths.js')
const { MANIFEST_PATH } = await import('../../agents/archive.js')

const app = createServer()

type Detail = { id: string; config: { name: string } }

function send(method: string, path: string, body?: unknown) {
    return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}

beforeAll(() => migrate())

describe('everos shared allowlist routes', () => {
    it('lists no one as pending after a hub create, and the new agent is allowlisted', async () => {
        const res = await send('POST', '/agents', { config: { name: 'Operator' } })
        expect(res.status).toBe(201)
        const id = ((await res.json()) as Detail).id
        expect(await isAllowlisted(id)).toBe(true)
        const pending = await send('GET', '/agents/everos-shared/pending')
        expect(pending.status).toBe(200)
        const body = (await pending.json()) as { agents: Array<{ id: string }> }
        expect(body.agents.some(agent => agent.id === id)).toBe(false)
    })

    it('confirms a pre-version agent and takes it off the pending list', async () => {
        const { createAgent } = await import('../../agents/factory.js')
        const agent = await createAgent({ config: { name: 'Legacy' } })
        expect(await isAllowlisted(agent.id)).toBe(false)
        const listed = await send('GET', '/agents/everos-shared/pending')
        expect(listed.status).toBe(200)
        const pending = (await listed.json()) as { agents: Array<{ id: string; name: string; reason: string }> }
        expect(pending.agents.some(row => row.id === agent.id && row.reason === 'pre_version')).toBe(true)
        const missing = await send('POST', '/agents/ghost/everos-shared', { confirm: true })
        expect(missing.status).toBe(404)
        const confirmed = await send('POST', `/agents/${agent.id}/everos-shared`, { confirm: true })
        expect(confirmed.status).toBe(200)
        expect(await isAllowlisted(agent.id)).toBe(true)
        const after = (await (await send('GET', '/agents/everos-shared/pending')).json()) as { agents: Array<{ id: string }> }
        expect(after.agents.some(row => row.id === agent.id)).toBe(false)
    })

    it('a duplicate inherits the source allowlist status', async () => {
        const created = await send('POST', '/agents', { config: { name: 'AllowedSource' } })
        const sourceId = ((await created.json()) as Detail).id
        const copyRes = await send('POST', `/agents/${sourceId}/duplicate`, { name: 'AllowedCopy' })
        expect(copyRes.status).toBe(201)
        const copyId = ((await copyRes.json()) as { id: string }).id
        expect(await isAllowlisted(copyId)).toBe(true)

        const legacy = await (await import('../../agents/factory.js')).createAgent({ config: { name: 'UnallowedSource' } })
        const unallowed = await send('POST', `/agents/${legacy.id}/duplicate`, { name: 'UnallowedCopy' })
        expect(unallowed.status).toBe(201)
        const unallowedId = ((await unallowed.json()) as { id: string }).id
        expect(await isAllowlisted(unallowedId)).toBe(false)
    })

    it('names import provenance on the pending list', async () => {
        const { createAgent } = await import('../../agents/factory.js')
        const agent = await createAgent({ config: { name: 'ImportedLook' } })
        await mkdir(agentDir(agent.id), { recursive: true })
        await writeFile(resolve(agentDir(agent.id), MANIFEST_PATH), '{}\n', 'utf8')
        const listed = await send('GET', '/agents/everos-shared/pending')
        const pending = (await listed.json()) as { agents: Array<{ id: string; reason: string }> }
        expect(pending.agents.some(row => row.id === agent.id && row.reason === 'import_manifest')).toBe(true)
    })
})
