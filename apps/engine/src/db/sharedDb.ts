import { existsSync } from 'node:fs'
import type { Client } from '@libsql/client'
import { sharedDbDir, sharedDbPath } from '../config/paths.js'
import { formatSchema, listTables, openStore, type SchemaOptions } from './sqlStore.js'
import { latestVersion, migrateSqlite, type SqliteMigration } from './ladder.js'
import { VIEWS_TABLE, viewNamesByTable } from './tableViews.js'
import { HttpError } from '../lib/errors.js'

const STORE_KEY = 'shared'
const META_TABLE = '_rerun_shared_tables'

export const SHARED_HIDDEN_TABLES = [META_TABLE, VIEWS_TABLE]

const META_DDL = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (table_name TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`

export const SHARED_DB_MIGRATIONS: SqliteMigration[] = [
    {
        version: 1,
        id: 'baseline',
        up: async client => {
            await client.execute(META_DDL)
        },
    },
    {
        version: 2,
        id: 'row-write-policy',
        up: async client => {
            const columns = await client.execute(`PRAGMA table_info(${META_TABLE})`)
            if (columns.rows.some(r => r.name === 'row_write')) return
            await client.execute(`ALTER TABLE ${META_TABLE} ADD COLUMN row_write TEXT NOT NULL DEFAULT 'owner' CHECK (row_write IN ('owner', 'shared'))`)
        },
    },
]

export const SHARED_DB_VERSION = latestVersion(SHARED_DB_MIGRATIONS)

let ready: Promise<Client> | null = null

export function getSharedDb(): Promise<Client> {
    if (!ready) {
        ready = openStore(STORE_KEY, sharedDbPath(), sharedDbDir())
            .then(async client => {
                await migrateSqlite(client, SHARED_DB_MIGRATIONS, sharedDbPath(), { atomic: true })
                return client
            })
            .catch(e => {
                ready = null
                throw e
            })
    }
    return ready
}

export function sharedDbExists(): boolean {
    return existsSync(sharedDbPath())
}

function stripComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const IDENT = String.raw`"(?:[^"]|"")*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][\w$]*`
const CREATE_TABLE = new RegExp(String.raw`\bcreate\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, 'gi')
const DROP_TABLE = new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${IDENT})`, 'gi')
const RENAME_TABLE = new RegExp(String.raw`\balter\s+table\s+(${IDENT})\s+rename\s+to\s+(${IDENT})`, 'gi')

function unquote(ident: string): string {
    if (ident.startsWith('"')) return ident.slice(1, -1).replace(/""/g, '"')
    if (ident.startsWith('`') || ident.startsWith('[')) return ident.slice(1, -1)
    return ident
}

function matches(re: RegExp, sql: string): string[][] {
    re.lastIndex = 0
    return [...sql.matchAll(re)].map(m => m.slice(1).map(unquote))
}

export async function recordTableOwnership(client: Client, statements: string[], agentName: string): Promise<void> {
    try {
        const now = new Date().toISOString()
        for (const raw of statements) {
            const sql = stripComments(raw)
            for (const [name] of matches(CREATE_TABLE, sql)) {
                if (name === META_TABLE) continue
                await client.execute({
                    sql: `INSERT INTO ${META_TABLE} (table_name, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(table_name) DO NOTHING`,
                    args: [name, agentName, now],
                })
            }
            for (const [name] of matches(DROP_TABLE, sql)) {
                await client.execute({ sql: `DELETE FROM ${META_TABLE} WHERE table_name = ?`, args: [name] })
            }
            for (const [from, to] of matches(RENAME_TABLE, sql)) {
                await client.execute({ sql: `UPDATE ${META_TABLE} SET table_name = ? WHERE table_name = ?`, args: [to, from] })
            }
        }
    } catch {}
}

export async function tableOwners(client: Client): Promise<Map<string, string>> {
    try {
        const rs = await client.execute(`SELECT table_name, created_by FROM ${META_TABLE}`)
        return new Map(rs.rows.map(r => [String(r.table_name), String(r.created_by)]))
    } catch {
        return new Map()
    }
}

export async function renameTableOwner(client: Client, fromAgentName: string, toAgentName: string): Promise<void> {
    await client.execute({ sql: `UPDATE ${META_TABLE} SET created_by = ? WHERE created_by = ?`, args: [toAgentName, fromAgentName] })
}

export type RowWrite = 'owner' | 'shared'
export type SharedTableOp = 'delete' | 'update' | 'replace' | 'upsert' | 'drop' | 'alter' | 'create_trigger' | 'create_index' | 'set_access'

const SCHEMA_OPS = new Set<SharedTableOp>(['drop', 'alter', 'create_trigger', 'create_index'])

function refusalText(table: string, op: SharedTableOp, owner: string): string {
    if (op === 'set_access') return `Only ${owner} can change access on ${table}`
    if (SCHEMA_OPS.has(op)) return `Only ${owner} can ${op.replace('_', ' ')} "${table}", because ${owner} created it.`
    return `"${table}" belongs to ${owner}: ask ${owner} to mark ${table} shared.`
}

export class SharedTablePermissionError extends HttpError {
    constructor(
        readonly table: string,
        readonly op: SharedTableOp,
        readonly owner: string,
    ) {
        super(403, refusalText(table, op, owner), 'shared_table_permission_denied')
    }
}

const QUALIFIED = String.raw`(?:(?:${IDENT})\s*\.\s*)?(${IDENT})`
const GUARDED: [SharedTableOp, RegExp][] = [
    ['drop', new RegExp(String.raw`\bdrop\s+table(?:\s+if\s+exists)?\s+${QUALIFIED}`, 'gi')],
    ['alter', new RegExp(String.raw`\balter\s+table\s+${QUALIFIED}`, 'gi')],
    ['create_trigger', new RegExp(String.raw`\bcreate\s+(?:temp(?:orary)?\s+)?trigger\b[\s\S]*?\bon\s+${QUALIFIED}`, 'gi')],
    ['create_index', new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+${QUALIFIED}`, 'gi')],
    ['delete', new RegExp(String.raw`\bdelete\s+from\s+${QUALIFIED}`, 'gi')],
    ['update', new RegExp(String.raw`\bupdate\s+(?:or\s+\w+\s+)?${QUALIFIED}`, 'gi')],
    ['replace', new RegExp(String.raw`\b(?:replace|insert\s+or\s+replace)\s+into\s+${QUALIFIED}`, 'gi')],
]
const INSERT_INTO = new RegExp(String.raw`\binsert\s+(?:or\s+\w+\s+)?into\s+${QUALIFIED}`, 'gi')
const DO_UPDATE = /\bdo\s+update\b/i

function guardedTargets(raw: string): [SharedTableOp, string][] {
    const sql = stripComments(raw)
    const found: [SharedTableOp, string][] = GUARDED.flatMap(([op, re]) => matches(re, sql).map(([name]): [SharedTableOp, string] => [op, name!.toLowerCase()]))
    if (DO_UPDATE.test(sql)) for (const [name] of matches(INSERT_INTO, sql)) found.push(['upsert', name!.toLowerCase()])
    return found
}

export type TablePolicy = { owner: string; rowWrite: RowWrite }

export async function tablePolicies(client: Client): Promise<Map<string, TablePolicy>> {
    const rs = await client.execute(`SELECT table_name, created_by, row_write FROM ${META_TABLE}`)
    return new Map(rs.rows.map(r => [String(r.table_name).toLowerCase(), { owner: String(r.created_by), rowWrite: r.row_write === 'shared' ? 'shared' : 'owner' }]))
}

export async function assertSharedTableOwnership(client: Client, statements: string[], agentName: string): Promise<void> {
    const targets = statements.flatMap(guardedTargets)
    if (targets.length === 0) return
    const policies = await tablePolicies(client)
    for (const [op, table] of targets) {
        const policy = policies.get(table)
        if (!policy || policy.owner === agentName) continue
        if (SCHEMA_OPS.has(op) || policy.rowWrite === 'owner') throw new SharedTablePermissionError(table, op, policy.owner)
    }
}

export async function setSharedTableAccess(client: Client, table: string, rowWrite: RowWrite, agentName: string): Promise<void> {
    const policy = (await tablePolicies(client)).get(table.toLowerCase())
    if (!policy) throw new HttpError(404, `No shared table named "${table}" has a recorded creator.`)
    if (policy.owner !== agentName) throw new SharedTablePermissionError(table, 'set_access', policy.owner)
    await client.execute({ sql: `UPDATE ${META_TABLE} SET row_write = ? WHERE lower(table_name) = ?`, args: [rowWrite, table.toLowerCase()] })
}

export async function setSharedTableAccessAsUser(client: Client, table: string, rowWrite: RowWrite): Promise<{ table: string; rowWrite: RowWrite; owner: string } | null> {
    const name = table.toLowerCase()
    const policy = (await tablePolicies(client)).get(name)
    if (!policy) return null
    await client.execute({ sql: `UPDATE ${META_TABLE} SET row_write = ? WHERE lower(table_name) = ?`, args: [rowWrite, name] })
    return { table: name, rowWrite, owner: policy.owner }
}

async function sharedQueues(client: Client): Promise<Set<string>> {
    try {
        const rs = await client.execute(`SELECT table_name FROM ${META_TABLE} WHERE row_write = 'shared'`)
        return new Set(rs.rows.map(r => String(r.table_name)))
    } catch {
        return new Set()
    }
}

export async function readSharedDbSchema(options: SchemaOptions = {}): Promise<string> {
    if (!sharedDbExists()) return ''
    const client = await getSharedDb()
    const [tables, owners, views, queues] = await Promise.all([listTables(client, SHARED_HIDDEN_TABLES), tableOwners(client), viewNamesByTable(client), sharedQueues(client)])
    return formatSchema(tables, {
        ...options,
        annotate: name => {
            const owner = owners.get(name)
            const viewList = views.get(name)
            return `${owner ? ` created by ${owner}` : ''}${queues.has(name) ? '; shared queue' : ''}${viewList?.length ? `; views: ${viewList.join(', ')}` : ''}`
        },
    })
}
