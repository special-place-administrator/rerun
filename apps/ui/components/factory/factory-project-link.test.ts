import { describe, expect, it } from 'vitest'
import { factoryProjectLimitsSchema, factoryProjectsSchema, isSafeFactoryRepo, parseGithubRepoLink } from '@moldwright/contracts'

const REFUSED = [
    'http://github.com/a/b',
    'ssh://git@github.com/a/b',
    'git@github.com:a/b.git',
    'git://github.com/a/b',
    'file:///tmp/x',
    'https://github.com.evil.com/a/b',
    'https://www.github.com/a/b',
    'https://api.github.com/a/b',
    'https://140.82.112.3/a/b',
    'https://u:p@github.com/a/b',
    'https://github.com@evil.com/a/b',
    'https://github.com:443/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#x',
    'https://github.com/a/%2e%2e',
    'https://github.com/a/..',
    'https://github.com/a/.',
    'https://github.com/a/-x',
    'https://github.com/a/.x',
    'https://github.com/a/b..c',
    'https://github.com/a/b/tree/dev',
    'https://github.com/a/b//',
    'https://github.com/a\\b/c',
    'https://github.com/a/b c',
    'https://github.com/a/b\u0007',
    'https://github.com/-a/b',
    'https://github.com/a_b/c',
    `https://github.com/${'a'.repeat(40)}/b`,
    `https://github.com/a/${'b'.repeat(101)}`,
    `https://github.com/a/${'b'.repeat(290)}`,
    'https://github.com/a',
    'https://github.com/',
    '/home/rob/repo',
    'C:\\repo',
    '',
]

describe('parseGithubRepoLink', () => {
    it.each(REFUSED)('refuses %j', link => {
        expect(parseGithubRepoLink(link)).toEqual({ ok: false, code: 'invalid_link' })
    })

    it('accepts a plain link, a .git link, a trailing slash and surrounding spaces, keeping the case typed', () => {
        expect(parseGithubRepoLink('https://github.com/special-place-ai-heaven/moldwright')).toEqual({ ok: true, repo: 'special-place-ai-heaven/moldwright' })
        expect(parseGithubRepoLink('https://github.com/special-place-ai-heaven/moldwright.git')).toEqual({ ok: true, repo: 'special-place-ai-heaven/moldwright' })
        expect(parseGithubRepoLink('https://github.com/special-place-ai-heaven/moldwright/')).toEqual({ ok: true, repo: 'special-place-ai-heaven/moldwright' })
        expect(parseGithubRepoLink('https://github.com/special-place-ai-heaven/moldwright.git/')).toEqual({ ok: true, repo: 'special-place-ai-heaven/moldwright' })
        expect(parseGithubRepoLink('  https://github.com/Acme/My_App.v2  ')).toEqual({ ok: true, repo: 'Acme/My_App.v2' })
        expect(parseGithubRepoLink('https://GitHub.com/acme/app')).toEqual({ ok: true, repo: 'acme/app' })
    })

    it('applies the same owner and repo rules to an owner/repo string', () => {
        expect(isSafeFactoryRepo('acme/app')).toBe(true)
        for (const repo of ['acme/..', 'acme/.', 'acme/-x', 'acme/.x', 'acme/a..b', '-acme/app', 'acme/app/x', 'acme', 'acme/']) expect(isSafeFactoryRepo(repo)).toBe(false)
    })
})

describe('factoryProjectLimitsSchema', () => {
    const limits = { max_count: 10, max_project_mb: 500, max_total_mb: 2000, upload_max_mb: 200, upload_max_files: 20000, upload_max_depth: 32, upload_max_file_mb: 50 }

    it('takes the seven limits as positive integers and refuses a missing, zero, fractional, extra or oversize one', () => {
        expect(factoryProjectLimitsSchema.parse(limits)).toEqual(limits)
        const { max_count: _missing, ...partial } = limits
        for (const bad of [partial, { ...limits, max_count: 0 }, { ...limits, max_project_mb: 1.5 }, { ...limits, extra: 1 }, { ...limits, max_count: 1001 }, { ...limits, upload_max_depth: 257 }]) {
            expect(factoryProjectLimitsSchema.safeParse(bad).success).toBe(false)
        }
    })
})

describe('factoryProjectsSchema items', () => {
    const base = { repos: [], ready: [], probes: [] }

    it('keeps an old report without items or owners, and reads the items and owners of a new one', () => {
        expect(factoryProjectsSchema.parse(base)).toEqual(base)
        const items = [{ id: 7, state: 'cloning', progress: { done: 10, total: 100, unit: 'pct' }, error_code: null }, { id: 8, state: 'failed', progress: null, error_code: 'not_reachable' }]
        const parsed = factoryProjectsSchema.parse({ ...base, owners: ['acme'], items })
        expect(parsed.items).toEqual(items)
        expect(parsed.owners).toEqual(['acme'])
    })

    it('refuses an item with an unknown state or code, and more than 1000 items', () => {
        expect(factoryProjectsSchema.safeParse({ ...base, items: [{ id: 1, state: 'done', progress: null, error_code: null }] }).success).toBe(false)
        expect(factoryProjectsSchema.safeParse({ ...base, items: [{ id: 1, state: 'failed', progress: null, error_code: 'stderr text' }] }).success).toBe(false)
        const many = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, state: 'ready', progress: null, error_code: null }))
        expect(factoryProjectsSchema.safeParse({ ...base, items: many }).success).toBe(false)
    })
})
