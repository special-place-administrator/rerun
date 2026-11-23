import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-shared-db-tool-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it } = await import('vitest')
const { sharedDbTools } = await import('./shared-db.js')

function toolsOf(name: string) {
    return sharedDbTools({ agent: { id: name, config: { name } } } as any)
}

const alice = toolsOf('alice')
const bob = toolsOf('bob')

async function run(tools: ReturnType<typeof toolsOf>, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = tools[name] as any
    return (await tool.execute(tool.inputSchema.parse(args), { toolCallId: 'c', messages: [] })) as string
}

describe('shared database tools', () => {
    it('says the shared database is empty before anyone wrote to it', async () => {
        expect(await run(alice, 'shared_db_schema', {})).toBe('The shared database has no tables yet. Create one with shared_db_execute (CREATE TABLE IF NOT EXISTS ...).')
    })

    it('records who created a table and keeps the first creator', async () => {
        expect(await run(alice, 'shared_db_execute', { sql: 'CREATE TABLE IF NOT EXISTS leads (email TEXT, score INTEGER)' })).toMatch(/^OK, 1 statement\(s\), 0 row\(s\) affected/)
        await run(bob, 'shared_db_execute', { sql: 'CREATE TABLE IF NOT EXISTS leads (email TEXT, score INTEGER)' })
        await run(bob, 'shared_db_execute', { statements: [{ sql: 'CREATE TABLE deals (name TEXT)' }, { sql: "INSERT INTO deals VALUES ('x')" }] })
        const schema = await run(bob, 'shared_db_schema', {})
        expect(schema.split('\n')).toEqual(['deals(name TEXT) created by bob', 'leads(email TEXT, score INTEGER) created by alice'])
    })

    it('binds params, reports the rowid and notes a truncated result', async () => {
        expect(await run(alice, 'shared_db_execute', { sql: 'INSERT INTO leads VALUES (?, ?)', params: ['a@x.io', 3] })).toBe('OK, 1 statement(s), 1 row(s) affected, lastInsertRowid=1')
        await run(alice, 'shared_db_execute', { statements: [{ sql: "INSERT INTO leads VALUES ('b@x.io', 5)" }, { sql: "INSERT INTO leads VALUES ('c@x.io', 7)" }] })
        expect(await run(bob, 'shared_db_query', { sql: 'SELECT email FROM leads WHERE score > ? ORDER BY score', params: [4] })).toBe('2 row(s)\n[{"email":"b@x.io"},{"email":"c@x.io"}]')
        expect(await run(bob, 'shared_db_query', { sql: 'SELECT email FROM leads ORDER BY score', limit: 1 })).toBe('3 row(s)\n[{"email":"a@x.io"}]\n[truncated to 1 of 3 rows]')
    })

    it('refuses the file functions on both tools', async () => {
        expect(await run(bob, 'shared_db_query', { sql: "SELECT readfile('/etc/passwd') AS v" })).toBe('Query failed: File access is not allowed in SQL.')
        expect(await run(alice, 'shared_db_execute', { sql: "SELECT writefile('/tmp/pwned', 'x')" })).toBe('Execution failed: File access is not allowed in SQL.')
    })

    it('refuses a write through the query tool', async () => {
        expect(await run(bob, 'shared_db_query', { sql: 'DELETE FROM leads' })).toBe('Query failed: Only a SELECT (or WITH … SELECT) can run here. Use the execute endpoint to change data.')
        expect(await run(bob, 'shared_db_query', { sql: 'WITH x AS (SELECT 1) DELETE FROM leads' })).toBe('Query failed: This statement writes. Use the execute endpoint instead.')
        expect(await run(bob, 'shared_db_query', { sql: 'SELECT count(*) AS c FROM leads' })).toBe('1 row(s)\n[{"c":3}]')
    })

    it('takes the last letter of the error as the table name', async () => {
        const out = await run(bob, 'shared_db_execute', { sql: 'INSERT INTO leads (email, stage) VALUES (?, ?)', params: ['d@x.io', 'new'] })
        expect(out).toBe('Execution failed: SQLITE_ERROR: table leads has no column named stage')

        await run(bob, 'shared_db_execute', { sql: 'CREATE TABLE e (other REAL)' })
        const misleading = await run(bob, 'shared_db_execute', { sql: 'INSERT INTO leads (email, stage) VALUES (?, ?)', params: ['d@x.io', 'new'] })
        expect(misleading).toBe('Execution failed: SQLITE_ERROR: table leads has no column named stage\nCurrent shape: e(other REAL)')
        await run(bob, 'shared_db_execute', { sql: 'DROP TABLE e' })
    })

    it('adds no shape when the name in the error is not a table', async () => {
        const noColumn = await run(bob, 'shared_db_query', { sql: 'SELECT stage FROM leads' })
        expect(noColumn).toMatch(/^Query failed: .*no such column: stage/)
        expect(noColumn).not.toContain('Current shape')
        const noTable = await run(bob, 'shared_db_query', { sql: 'SELECT * FROM ghosts' })
        expect(noTable).toMatch(/^Query failed: .*no such table: ghosts/)
        expect(noTable).not.toContain('Current shape')
        expect(await run(bob, 'shared_db_execute', {})).toBe('Execution failed: Provide either sql or statements.')
    })

    it("guards another coworker's rows by the table's row_write policy and its schema always, and backfills existing tables to owner", async () => {
        const refused = (out: string, op: string) => {
            expect(out).toContain('shared_table_permission_denied')
            expect(out).toContain(`op=${op}`)
            expect(out).toContain('owner=alice')
        }
        refused(await run(bob, 'shared_db_execute', { sql: 'DELETE FROM LEADS' }), 'delete')
        refused(await run(bob, 'shared_db_execute', { sql: "UPDATE leads SET email = ''" }), 'update')
        refused(await run(bob, 'shared_db_execute', { sql: "REPLACE INTO leads VALUES ('a@x.io', 0)" }), 'replace')
        refused(await run(bob, 'shared_db_execute', { sql: "INSERT OR REPLACE INTO leads VALUES ('a@x.io', 0)" }), 'replace')
        refused(await run(bob, 'shared_db_execute', { statements: [{ sql: 'SELECT 1' }, { sql: "INSERT INTO [leads] VALUES ('a@x.io', 0) ON CONFLICT DO UPDATE SET score = 0" }] }), 'upsert')
        refused(await run(bob, 'shared_db_execute', { sql: 'CREATE INDEX leads_by_score ON leads (score)' }), 'create_index')
        expect(await run(bob, 'shared_db_execute', { sql: "INSERT INTO leads VALUES ('q@x.io', 1)" })).toMatch(/^OK/)
        refused(await run(bob, 'shared_db_set_table_access', { table: 'leads', access: 'shared' }), 'set_access')
        expect(await run(alice, 'shared_db_set_table_access', { table: 'leads', access: 'shared' })).toMatch(/shared/)
        expect(await run(alice, 'shared_db_schema', {})).toContain('shared queue')
        expect(await run(bob, 'shared_db_execute', { sql: "DELETE FROM leads WHERE email = 'q@x.io'" })).toMatch(/^OK/)
        refused(await run(bob, 'shared_db_execute', { sql: 'ALTER TABLE main.leads ADD COLUMN stage TEXT' }), 'alter')
        refused(await run(bob, 'shared_db_execute', { sql: 'DROP TABLE IF EXISTS "leads"' }), 'drop')
        await run(alice, 'shared_db_set_table_access', { table: 'leads', access: 'owner' })
        expect(await run(bob, 'shared_db_query', { sql: 'SELECT count(*) AS c FROM leads' })).toBe('1 row(s)\n[{"c":3}]')

        const { createClient } = await import('@libsql/client')
        const { SHARED_DB_MIGRATIONS } = await import('../../db/sharedDb.js')
        const { migrateSqlite } = await import('../../db/ladder.js')
        const old = createClient({ url: ':memory:' })
        await SHARED_DB_MIGRATIONS[0]!.up(old)
        await old.execute('PRAGMA user_version = 1')
        await old.execute("INSERT INTO _rerun_shared_tables (table_name, created_by, created_at) VALUES ('queue', 'alice', 'now')")
        await migrateSqlite(old, SHARED_DB_MIGRATIONS, ':memory:')
        await old.execute("INSERT INTO _rerun_shared_tables (table_name, created_by, created_at) VALUES ('fresh', 'alice', 'now')")
        expect((await old.execute('SELECT table_name, row_write FROM _rerun_shared_tables ORDER BY table_name')).rows.map(r => [r.table_name, r.row_write])).toEqual([['fresh', 'owner'], ['queue', 'owner']])

        const interrupted = createClient({ url: ':memory:' })
        await SHARED_DB_MIGRATIONS[0]!.up(interrupted)
        await interrupted.execute('PRAGMA user_version = 1')
        await interrupted.execute("ALTER TABLE _rerun_shared_tables ADD COLUMN row_write TEXT NOT NULL DEFAULT 'owner'")
        await migrateSqlite(interrupted, SHARED_DB_MIGRATIONS, ':memory:')
        expect(Number((await interrupted.execute('PRAGMA user_version')).rows[0]!.user_version)).toBe(2)
    })

    it('blocks another coworker from dropping an owned table, forgets the owner when its creator drops it, and hides its own bookkeeping', async () => {
        expect(await run(alice, 'shared_db_execute', { sql: 'DROP TABLE deals' })).toContain('owner=bob')
        await run(bob, 'shared_db_execute', { sql: 'DROP TABLE deals' })
        const schema = await run(alice, 'shared_db_schema', {})
        expect(schema).toBe('leads(email TEXT, score INTEGER) created by alice')
        expect(schema).not.toContain('_rerun_shared_tables')
    })
})
