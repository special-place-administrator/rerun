import { raw } from './client.js'
import { EVEROS_ALLOWLIST_DDL } from '../agents/everos-allowlist.js'

const AGENTS_INDEX_DDL = `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL
)`

const DDL = `
PRAGMA journal_mode = WAL;

${AGENTS_INDEX_DDL};

${EVEROS_ALLOWLIST_DDL};

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS runs;
`

export async function migrate(): Promise<void> {
    await raw().executeMultiple(DDL)
}

export async function ensureAgentsIndex(): Promise<void> {
    await raw().execute(AGENTS_INDEX_DDL)
    await raw().execute(EVEROS_ALLOWLIST_DDL)
}
