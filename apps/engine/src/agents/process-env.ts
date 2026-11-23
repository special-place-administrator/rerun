import { mkdirSync } from 'node:fs'
import { agentDataDbPath, agentDataDir, sharedDbDir, sharedDbPath, workspaceDir } from '../config/paths.js'
import type { LoadedAgent } from './types.js'
import { readSharedEnvSync } from './shared-env.js'

export type AgentProcessEnv = { cwd: string; env: Record<string, string> }

export function sharedProcessEnv(): Record<string, string> {
    return readSharedEnvSync()
}

const SHARED_NON_SECRET_KEYS = ['EVEROS_URL', 'EVEROS_USER_ID', 'EVEROS_APP', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER'] as const

const SHARED_SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|DSN|DATABASE_URL)/i

function sharedNonSecretEnv(): Record<string, string> {
    const shared = readSharedEnvSync()
    return Object.fromEntries(SHARED_NON_SECRET_KEYS.filter(key => shared[key] !== undefined && !SHARED_SECRET_NAME.test(key)).map(key => [key, shared[key]!]))
}

export function agentProcessEnv(agent: Pick<LoadedAgent, 'id' | 'env' | 'config'>, labels?: Record<string, string>): AgentProcessEnv {
    const cwd = workspaceDir(agent.id)
    mkdirSync(cwd, { recursive: true })
    mkdirSync(agentDataDir(agent.id), { recursive: true })
    const env: Record<string, string> = { ...sharedNonSecretEnv(), ...agent.env, ...labels, RERUN_AGENT_DB: agentDataDbPath(agent.id), RERUN_WORKSPACE: cwd }
    if (agent.config.tools.sharedDb) {
        mkdirSync(sharedDbDir(), { recursive: true })
        env.RERUN_SHARED_DB = sharedDbPath()
    }
    return { cwd, env }
}
