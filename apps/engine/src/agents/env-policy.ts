import { logger } from '../lib/logger.js'

const LOADER_ENV_KEYS = new Set(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'BASH_ENV', 'ENV'])

export function isLoaderEnvKey(key: string): boolean {
    const upper = key.toUpperCase()
    return LOADER_ENV_KEYS.has(upper) || upper.startsWith('NPM_CONFIG_')
}

export function withoutLoaderEnvKeys(env: Record<string, string>, where: string): Record<string, string> {
    const dropped = Object.keys(env).filter(isLoaderEnvKey)
    if (dropped.length === 0) return env
    logger.warn({ where, keys: dropped }, 'env: dropped loader or hook variables')
    return Object.fromEntries(Object.entries(env).filter(([key]) => !isLoaderEnvKey(key)))
}
