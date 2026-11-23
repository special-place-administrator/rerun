import { readdirSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { type ToolSet } from 'ai'
import { makeFsTools } from './fsTools.js'
import { isPathSegment, workspaceDir } from '../../config/paths.js'
import { env } from '../../config/env.js'
import type { AgentConfig } from '../../agents/types.js'
import type { RunContext, RunLineage } from '../../runtime/context.js'

const JOB_REF = /^(?:.*\/)?([^#/]+)#([1-9][0-9]*)$/

function jobWorktrees(root: string, jobRef: string): string[] {
    const match = JOB_REF.exec(jobRef.trim())
    if (!match || !isPathSegment(match[1]!)) return []
    const prefix = `${match[2]}-`
    try {
        const realRoot = realpathSync(root)
        const repoDir = realpathSync(resolve(realRoot, match[1]!))
        if (dirname(repoDir) !== realRoot) return []
        return readdirSync(repoDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
            .map(entry => realpathSync(resolve(repoDir, entry.name)))
            .filter(path => dirname(path) === repoDir)
    } catch {
        return []
    }
}

function fsExtraRootBases(config: AgentConfig): string[] {
    if (!config.tools.shell) return []
    return (env().RERUN_FS_EXTRA_ROOTS ?? '').split(delimiter).filter(root => isAbsolute(root)).map(root => resolve(root))
}

export function fsExtraRoots(config: AgentConfig, lineage?: RunLineage): string[] {
    const jobRef = lineage?.jobRef
    return jobRef ? fsExtraRootBases(config).flatMap(root => jobWorktrees(root, jobRef)) : fsExtraRootBases(config)
}

export function filesystemTools(ctx: RunContext): ToolSet {
    return makeFsTools({ prefix: 'fs', label: 'coworker workspace', rootDir: workspaceDir(ctx.agent.id), extraRoots: fsExtraRootBases(ctx.agent.config), extraRootsNow: () => fsExtraRoots(ctx.agent.config, ctx.lineage) })
}
