import { cn } from '@/lib/utils'

const PROJECT_COLORS = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#dc2626', '#0284c7', '#475569', '#65a30d']

export function projectLook(repo: string): { color: string; initial: string } {
    let hash = 0x811c9dc5
    for (const ch of repo.toLowerCase()) hash = Math.imul(hash ^ ch.codePointAt(0)!, 0x01000193) >>> 0
    const name = repo.slice(repo.indexOf('/') + 1)
    return { color: PROJECT_COLORS[hash % PROJECT_COLORS.length]!, initial: (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase() }
}

export function ProjectMark({ repo, className }: { repo: string; className?: string }) {
    const { color, initial } = projectLook(repo)
    return (
        <span role="img" aria-label={repo} title={repo} data-project-mark={repo}
            className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none text-white', className)}
            style={{ background: color }}>
            <span aria-hidden>{initial}</span>
        </span>
    )
}
