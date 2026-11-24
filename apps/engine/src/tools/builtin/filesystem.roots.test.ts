import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-fs-roots-'))
const jobs = mkdtempSync(resolve(tmpdir(), 'rerun-fs-jobs-'))
const outside = mkdtempSync(resolve(tmpdir(), 'rerun-fs-outside-'))
process.env.RERUN_DATA_DIR = dataDir
process.env.RERUN_FS_EXTRA_ROOTS = jobs

vi.mock('../../agents/everos-allowlist.js', () => ({
    trustRefusal: async (agent: { id: string }) => (agent.id === 'stranger' ? 'confirm this coworker first' : null),
}))

const { describe, expect, it, beforeAll } = await import('vitest')
const { extraRootsAllowed, filesystemTools } = await import('./filesystem.js')
const { workspaceDir } = await import('../../config/paths.js')

const ctxFor = (id: string, shell: boolean, jobRef?: string) => ({ agent: { id, config: { tools: { shell } } }, ...(jobRef ? { lineage: { jobRef } } : {}) }) as unknown as Parameters<typeof filesystemTools>[0]
const withShell = filesystemTools(ctxFor('builder', true, 'repo#1'), true)
const withoutShell = filesystemTools(ctxFor('writer', false), true)
const job = resolve(jobs, 'repo', '1-job')

function run(tools: typeof withShell, name: string, args: Record<string, unknown>): Promise<string> {
    return (tools[name] as any).execute(args, {} as any)
}

beforeAll(async () => {
    await mkdir(job, { recursive: true })
    await mkdir(workspaceDir('builder'), { recursive: true })
    await writeFile(resolve(outside, 'secret.txt'), 'secret', 'utf8')
    await symlink(outside, resolve(job, 'link-out'), 'junction')
})

describe('fs tools with extra roots for a coworker with the shell on', () => {
    it('writes, reads, edits, lists and searches a job folder by absolute path', async () => {
        const file = resolve(job, 'src', 'a.ts')
        await run(withShell, 'fs_write', { path: file, content: 'const a = 1\n' })
        expect(await readFile(file, 'utf8')).toBe('const a = 1\n')
        expect(await run(withShell, 'fs_edit', { path: file, oldString: '1', newString: '2', replaceAll: false })).toContain('Edited')
        expect(await run(withShell, 'fs_read', { path: file })).toBe('const a = 2\n')
        expect(await run(withShell, 'fs_list', { path: resolve(job, 'src') })).toBe('a.ts')
        expect(await run(withShell, 'fs_search', { path: job, pattern: 'const a', maxResults: 10 })).toBe(`${file}:1: const a = 2`)
    })

    it('still reads a relative path in the workspace', async () => {
        await run(withShell, 'fs_write', { path: 'note.txt', content: 'mine' })
        expect(await readFile(resolve(workspaceDir('builder'), 'note.txt'), 'utf8')).toBe('mine')
    })

    it('refuses an absolute path outside every root', async () => {
        await expect(run(withShell, 'fs_read', { path: resolve(outside, 'secret.txt') })).rejects.toThrow('escapes the root')
    })

    it('refuses a path that climbs out of the job folder', async () => {
        await expect(run(withShell, 'fs_write', { path: `${job}/../../../${outside.split(/[\\/]/).pop()}/x.txt`, content: 'x' })).rejects.toThrow('escapes the root')
    })

    it('refuses a symlink in the job folder that points outside it', async () => {
        await expect(run(withShell, 'fs_read', { path: resolve(job, 'link-out', 'secret.txt') })).rejects.toThrow('escapes the root')
    })

    it('tells the model the job folders are allowed', () => {
        expect((withShell.fs_write as any).description).toContain(jobs)
    })

    it('scopes extra roots to the assigned job worktree when jobRef lineage is present', async () => {
        const job2 = resolve(jobs, 'repo', '200-other')
        const job1 = resolve(jobs, 'repo', '100-mine')
        await mkdir(job1, { recursive: true })
        await mkdir(job2, { recursive: true })
        await writeFile(resolve(job1, 'ok.txt'), 'mine', 'utf8')
        await writeFile(resolve(job2, 'sibling.txt'), 'theirs', 'utf8')
        const scoped = filesystemTools(ctxFor('builder', true, 'repo#100'), true)
        expect(await run(scoped, 'fs_read', { path: resolve(job1, 'ok.txt') })).toBe('mine')
        await expect(run(scoped, 'fs_read', { path: resolve(job2, 'sibling.txt') })).rejects.toThrow('escapes the root')
    })

    it('keeps the configured roots without a job reference and grants none for one that names a parent folder', async () => {
        const besideJobs = mkdtempSync(resolve(jobs, '..', '100-'))
        await writeFile(resolve(besideJobs, 'x.txt'), 'x', 'utf8')
        await expect(run(filesystemTools(ctxFor('builder', true, '..#100'), true), 'fs_read', { path: resolve(besideJobs, 'x.txt') })).rejects.toThrow('escapes the root')
        await writeFile(resolve(job, 'unscoped.txt'), 'x', 'utf8')
        expect(await run(filesystemTools(ctxFor('builder', true), true), 'fs_read', { path: resolve(job, 'unscoped.txt') })).toBe('x')
    })
})

describe('fs tools for a coworker without the shell', () => {
    it('keeps the workspace as the only root', async () => {
        await expect(run(withoutShell, 'fs_write', { path: resolve(job, 'b.txt'), content: 'x' })).rejects.toThrow('escapes the root')
        expect((withoutShell.fs_write as any).description).not.toContain(jobs)
    })
})

describe('fs extra roots for a coworker that is not confirmed', () => {
    it('grants the job folders only once the coworker is confirmed', async () => {
        await writeFile(resolve(job, 'confirmed.txt'), 'x', 'utf8')
        const stranger = ctxFor('stranger', true)
        const builder = ctxFor('builder', true)
        await expect(run(filesystemTools(stranger, await extraRootsAllowed(stranger.agent)), 'fs_read', { path: resolve(job, 'confirmed.txt') })).rejects.toThrow('escapes the root')
        expect(await run(filesystemTools(builder, await extraRootsAllowed(builder.agent)), 'fs_read', { path: resolve(job, 'confirmed.txt') })).toBe('x')
    })
})
