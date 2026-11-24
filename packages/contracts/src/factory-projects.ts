import { z } from 'zod'

export const FACTORY_PROJECT_SOURCES = ['github', 'upload'] as const
export const FACTORY_PROJECT_STATES = ['queued', 'uploading', 'cloning', 'unpacking', 'checking', 'ready', 'failed'] as const
export const FACTORY_PROJECT_ERROR_CODES = [
    'invalid_link', 'owner_not_allowed', 'not_reachable', 'quota_unset', 'quota_exceeded', 'upload_too_large', 'too_many_files',
    'unsafe_entry', 'checksum_mismatch', 'no_github_remote', 'disk_low', 'timed_out', 'already_added', 'unknown',
] as const

export const factoryProjectSourceSchema = z.enum(FACTORY_PROJECT_SOURCES)
export const factoryProjectStateSchema = z.enum(FACTORY_PROJECT_STATES)
export const factoryProjectErrorCodeSchema = z.enum(FACTORY_PROJECT_ERROR_CODES)

export type FactoryProjectSource = z.infer<typeof factoryProjectSourceSchema>
export type FactoryProjectState = z.infer<typeof factoryProjectStateSchema>
export type FactoryProjectErrorCode = z.infer<typeof factoryProjectErrorCodeSchema>

const SAFE_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const GITHUB_PREFIX = 'https://github.com/'
const LINK_MAX = 300
const LINK_PATH_CHARS = /^[A-Za-z0-9_./-]+$/

export function isSafeFactoryRepo(repo: string): boolean {
    return SAFE_REPO_PATTERN.test(repo) && !repo.includes('..')
}

export function parseGithubRepoLink(text: string): { ok: true; repo: string } | { ok: false; code: 'invalid_link' } {
    const link = text.trim()
    const refused = { ok: false, code: 'invalid_link' } as const
    if (link.length > LINK_MAX || link.slice(0, GITHUB_PREFIX.length).toLowerCase() !== GITHUB_PREFIX) return refused
    const path = link.slice(GITHUB_PREFIX.length)
    if (!LINK_PATH_CHARS.test(path)) return refused
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
    const repo = trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed
    return isSafeFactoryRepo(repo) ? { ok: true, repo } : refused
}

const limit = (max: number) => z.number().int().min(1).max(max)

export const factoryProjectLimitsSchema = z.object({
    max_count: limit(1000),
    max_project_mb: limit(1_000_000),
    max_total_mb: limit(10_000_000),
    upload_max_mb: limit(100_000),
    upload_max_files: limit(1_000_000),
    upload_max_depth: limit(256),
    upload_max_file_mb: limit(100_000),
}).strict()

export type FactoryProjectLimits = z.infer<typeof factoryProjectLimitsSchema>

const amount = z.number().int().min(0)

const DROPPED_MAX = 50

export const factoryProjectDroppedSchema = z.array(z.object({ label: z.string().max(40), path: z.string().max(300) })).max(DROPPED_MAX)

export type FactoryProjectDropped = z.infer<typeof factoryProjectDroppedSchema>

export const factoryProjectItemSchema = z.object({
    id: z.number().int().positive(),
    state: factoryProjectStateSchema,
    progress: z.object({ done: amount, total: amount, unit: z.enum(['bytes', 'pct']) }).nullable(),
    error_code: factoryProjectErrorCodeSchema.nullable(),
    identified_repo: z.string().max(201).optional(),
    head: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/).nullable().optional(),
    dropped: factoryProjectDroppedSchema.optional(),
})

export type FactoryProjectItem = z.infer<typeof factoryProjectItemSchema>
