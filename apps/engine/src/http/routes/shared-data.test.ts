import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-shared-data-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_INSECURE_NO_AUTH = '1'

const { describe, expect, it } = await import('vitest')
const { createServer } = await import('../server.js')

const app = createServer()

function post(path: string, body: unknown) {
    return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('shared database over HTTP', () => {
    it('is reachable without naming an agent', async () => {
        const created = await post('/shared/data/execute', { sql: 'CREATE TABLE leads (id INTEGER PRIMARY KEY, email TEXT NOT NULL)' })
        expect(created.status).toBe(200)

        const tables = (await (await app.request('/shared/data/tables')).json()) as { tables: { name: string }[] }
        expect(tables.tables.map(t => t.name)).toEqual(['leads'])
    })

    it('lists each table with its row_write and owner, and lets the user set access with no owner check', async () => {
        const { getSharedDb, recordTableOwnership } = await import('../../db/sharedDb.js')
        await post('/shared/data/execute', { sql: 'CREATE TABLE queue (id INTEGER PRIMARY KEY)' })
        await recordTableOwnership(await getSharedDb(), ['CREATE TABLE queue (id INTEGER PRIMARY KEY)'], 'alice')
        const put = (name: string, body: unknown) => app.request(`/shared/data/tables/${name}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const res = await put('Queue', { rowWrite: 'shared' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ table: 'queue', rowWrite: 'shared', owner: 'alice' })
        const tables = (await (await app.request('/shared/data/tables')).json()) as { tables: { name: string; rowWrite: string | null; owner: string | null }[] }
        expect(tables.tables.map(t => [t.name, t.rowWrite, t.owner])).toEqual([['leads', null, null], ['queue', 'shared', 'alice']])
        expect((await put('leads', { rowWrite: 'shared' })).status).toBe(404)
        expect((await put('queue', { rowWrite: 'everyone' })).status).toBe(400)
    })

    it('never exposes its bookkeeping table', async () => {
        const tables = (await (await app.request('/shared/data/tables')).json()) as { tables: { name: string }[] }
        expect(tables.tables.map(t => t.name)).not.toContain('_rerun_shared_tables')
        expect((await app.request('/shared/data/tables/_rerun_shared_tables/rows')).status).toBe(500)
        expect((await app.request('/shared/data/tables/_rerun_shared_tables/purge', { method: 'POST' })).status).toBe(500)
    })

    it('reads back what was written and refuses a write on the query endpoint', async () => {
        await post('/shared/data/execute', { sql: 'INSERT INTO leads (email) VALUES (?)', params: ['a@example.com'] })
        const read = await post('/shared/data/query', { sql: 'SELECT email FROM leads' })
        expect(await read.json()).toMatchObject({ rows: [{ email: 'a@example.com' }], rowCount: 1 })
        expect((await post('/shared/data/query', { sql: 'DELETE FROM leads' })).status).toBe(400)
    })

    it('refuses to reach another database by path', async () => {
        expect((await post('/shared/data/execute', { sql: "ATTACH DATABASE '/tmp/elsewhere.db' AS other" })).status).toBe(400)
    })

    it('leaves the agent databases untouched', async () => {
        expect((await app.request('/agents/ghost/data/tables')).status).toBe(404)
    })
})
