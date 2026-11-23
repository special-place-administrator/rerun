import type { Client, Transaction } from '@libsql/client'
import { logger } from '../lib/logger.js'

export type MigrationClient = Pick<Transaction, 'execute' | 'executeMultiple' | 'batch'>
export type SqliteMigration = { version: number; id: string; up: (client: MigrationClient) => Promise<void> }

export const latestVersion = (steps: { version: number }[]): number => steps.at(-1)?.version ?? 0

export async function sqliteVersion(client: MigrationClient): Promise<number> {
    const rs = await client.execute('PRAGMA user_version')
    return Number(rs.rows[0]?.user_version ?? 0)
}

export async function migrateSqlite(client: Client, steps: SqliteMigration[], file: string, { atomic = false }: { atomic?: boolean } = {}): Promise<void> {
    const current = await sqliteVersion(client)
    const target = latestVersion(steps)
    if (current > target) {
        logger.warn({ file, current, target }, 'sqlite file is newer than this engine, leaving it as is')
        return
    }
    for (const step of steps) {
        if (step.version <= current) continue
        if (!atomic) {
            await step.up(client)
            await client.execute(`PRAGMA user_version = ${step.version}`)
            continue
        }
        const tx = await client.transaction('write')
        try {
            if ((await sqliteVersion(tx)) < step.version) {
                await step.up(tx)
                await tx.execute(`PRAGMA user_version = ${step.version}`)
            }
            await tx.commit()
        } catch (e) {
            await tx.rollback().catch(() => {})
            throw e
        } finally {
            tx.close()
        }
    }
}
