import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { type ToolSet } from 'ai'
import { makeFsTools } from './fsTools.js'
import { isPathSegment, workspaceDir } from '../../config/paths.js'
import { env } from '../../config/env.js'
import { trustRefusal } from '../../agents/everos-allowlist.js'
import type { AgentConfig } from '../../agents/types.js'
import type { RunContext, RunLineage } from '../../runtime/context.js'

const JOB_REF = /^(?:(?:.*\/)?([^#/]+)\/)?([^#/]+)#([1-9][0-9]*)$/

function jobWorktrees(root: string, jobRef: string): string[] {
    const match = JOB_REF.exec(jobRef.trim())
    if (!match || !isPathSegment(match[2]!)) return []
    const prefix = `${match[3]}-`
    try {
        const realRoot = realpathSync(root)
        const folders = match[1] ? [`${match[1]}+${match[2]}`, match[2]!] : [match[2]!]
        const folder = folders.find(name => isPathSegment(name) && existsSync(resolve(realRoot, name)))
        if (!folder) return []
        const repoDir = realpathSync(resolve(realRoot, folder))
        if (dirname(repoDir) !== realRoot) return []
        return readdirSync(repoDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
            .map(entry => realpathSync(resolve(repoDir, entry.name)))
            .filter(path => dirname(path) === repoDir)
    } catch {
        return []
    }
}

export async function extraRootsAllowed(agent: { id: string; hubAgentId?: string; config: AgentConfig }): Promise<boolean> {
    return agent.config.tools.shell && (await trustRefusal(agent)) === null
}

function fsExtraRootBases(config: AgentConfig, allowed: boolean): string[] {
    if (!allowed || !config.tools.shell) return []
    return (env().RERUN_FS_EXTRA_ROOTS ?? '').split(delimiter).filter(root => isAbsolute(root)).map(root => resolve(root))
}

export function fsExtraRoots(config: AgentConfig, allowed: boolean, lineage?: RunLineage): string[] {
    const jobRef = lineage?.jobRef
    return jobRef ? fsExtraRootBases(config, allowed).flatMap(root => jobWorktrees(root, jobRef)) : fsExtraRootBases(config, allowed)
}

export function filesystemTools(ctx: RunContext, rootsAllowed = false): ToolSet {
    return makeFsTools({ prefix: 'fs', label: 'coworker workspace', rootDir: workspaceDir(ctx.agent.id), extraRoots: fsExtraRootBases(ctx.agent.config, rootsAllowed), extraRootsNow: () => fsExtraRoots(ctx.agent.config, rootsAllowed, ctx.lineage) })
}
