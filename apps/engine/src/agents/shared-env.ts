import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mcpDir, sharedEnvPath } from '../config/paths.js'
import { parseEnvFile, writeEnvFile } from '../lib/env-file.js'
import { withoutLoaderEnvKeys } from './env-policy.js'
import type { LoadedAgent } from './types.js'

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|DSN|DATABASE_URL)/i
const SECRET_MIN_LENGTH = 8

export function readSharedEnvSync(): Record<string, string> {
    return existsSync(sharedEnvPath()) ? parseEnvFile(readFileSync(sharedEnvPath(), 'utf8')) : {}
}

export async function writeSharedEnv(env: Record<string, string>): Promise<void> {
    await writeEnvFile(sharedEnvPath(), withoutLoaderEnvKeys(env, 'shared'))
}

export function secretValuesOf(env: Record<string, string>): string[] {
    return Object.entries(env)
        .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= SECRET_MIN_LENGTH)
        .map(([, value]) => value)
}

function storedMcpSecrets(agentId: string): string[] {
    const dir = mcpDir(agentId)
    if (!existsSync(dir)) return []
    const values: string[] = []
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        try {
            const stored = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as Record<string, unknown>
            for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
                const value = stored[field]
                if (typeof value === 'string') values.push(value)
            }
        } catch {
            continue
        }
    }
    return values
}

export type SecretBearingAgent = Pick<LoadedAgent, 'id' | 'env'> & { resolved?: { connection?: { env?: Record<string, string> } | null } }

export function agentSecretValues(agent: SecretBearingAgent): string[] {
    const values = [...Object.values(agent.env), ...Object.values(agent.resolved?.connection?.env ?? {}), ...secretValuesOf(readSharedEnvSync()), ...storedMcpSecrets(agent.id)]
    return [...new Set(values.filter(value => value.length >= SECRET_MIN_LENGTH))]
}
