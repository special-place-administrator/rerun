import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { FOREMAN_AGENT_ID } from '@moldwright/contracts'
import { raw } from '../db/client.js'
import { agentDir, dataDir, isPathSegment } from '../config/paths.js'
import { listAgentIndex } from '../db/repos/agents.js'
import { nowIso } from '../lib/ids.js'

export const EVEROS_ALLOWLIST_DDL = `CREATE TABLE IF NOT EXISTS everos_shared_allowlist (
    agent_id TEXT PRIMARY KEY,
    allowed_at TEXT NOT NULL,
    source TEXT NOT NULL
)`

export type AllowlistSource = 'create' | 'confirm' | 'duplicate'

export type PendingReason = 'import_manifest' | 'import_marker' | 'pre_version'

export type PendingAgent = { id: string; name: string; reason: PendingReason }

export const SHELL_NEEDS_CONFIRM = 'shell needs operator confirm (rerun agent everos-allow / confirm)'

const leftoverMarker = (id: string) => resolve(dataDir(), 'imported-agents', id)

export async function ensureEverosAllowlist(): Promise<void> {
    await raw().execute(EVEROS_ALLOWLIST_DDL)
}

export async function isAllowlisted(id: string): Promise<boolean> {
    try {
        await ensureEverosAllowlist()
        const rs = await raw().execute({ sql: 'SELECT 1 AS ok FROM everos_shared_allowlist WHERE agent_id = ?', args: [id] })
        return rs.rows.length > 0
    } catch {
        return false
    }
}

export async function trustRefusal(agent: { id: string; hubAgentId?: string }): Promise<string | null> {
    return (await isAllowlisted(agent.hubAgentId ?? agent.id)) ? null : SHELL_NEEDS_CONFIRM
}

export async function allowAgent(id: string, source: AllowlistSource): Promise<void> {
    await ensureEverosAllowlist()
    await raw().execute({
        sql: 'INSERT OR IGNORE INTO everos_shared_allowlist (agent_id, allowed_at, source) VALUES (?, ?, ?)',
        args: [id, nowIso(), source],
    })
}

export async function inheritAllowlist(sourceId: string, destId: string): Promise<void> {
    if (await isAllowlisted(sourceId)) await allowAgent(destId, 'duplicate')
}

export function pendingReason(id: string): PendingReason {
    if (existsSync(resolve(agentDir(id), '.rerun-capture.json'))) return 'import_manifest'
    if (isPathSegment(id) && existsSync(leftoverMarker(id))) return 'import_marker'
    return 'pre_version'
}

export async function listPendingEveros(): Promise<PendingAgent[]> {
    const pending: PendingAgent[] = []
    for (const row of await listAgentIndex()) {
        if (row.id === FOREMAN_AGENT_ID) continue
        if (await isAllowlisted(row.id)) continue
        pending.push({ id: row.id, name: row.name, reason: pendingReason(row.id) })
    }
    return pending
}
