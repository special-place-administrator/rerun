'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, Trash2 } from 'lucide-react'
import { sleep, type FactorySnapshot } from '@moldwright/contracts'
import { addFactoryPathAction, addFactoryRepoAction, listFactoryProjectsAction, removeFactoryProjectAction, selectFactoryProjectAction } from '@/app/api/_actions/factory.actions'
import type { FactoryProject, FactoryReadyLine } from '@/app/api/_services/factory-projects.service'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { useErrorText } from '@/hooks/useErrorText'
import { ProjectMark } from './ProjectMark'
import { groupOf } from './factory-state'
import { thrown } from './use-factory-controls'

const POLL_MS = 5_000
const shownName = (project: FactoryProject) => project.repo ?? project.name
type Confirm = { kind: 'select' | 'remove'; project: FactoryProject } | null

export function FactoryProjectPicker({ snapshot, open: openProp, onOpenChange }: { snapshot: FactorySnapshot; open?: boolean; onOpenChange?: (open: boolean) => void }) {
    const t = useTranslations('factory.projects')
    const errorText = useErrorText()
    const [projects, setProjects] = useState<FactoryProject[] | null>(null)
    const [isOwner, setIsOwner] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [ownOpen, setOwnOpen] = useState(false)
    const open = openProp ?? ownOpen
    const setOpen = onOpenChange ?? setOwnOpen
    const [adding, setAdding] = useState(false)
    const [path, setPath] = useState('')
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState('')
    const [lines, setLines] = useState<FactoryReadyLine[]>([])
    const [confirm, setConfirm] = useState<Confirm>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const alive = useRef(true)
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    const apply = useCallback((res: Awaited<ReturnType<typeof listFactoryProjectsAction>> | ReturnType<typeof thrown>) => {
        if (!alive.current) return
        if (!res.ok) { setLoadError(errorText(res)); return }
        setLoadError(null)
        setProjects(res.projects)
        setIsOwner(res.isOwner)
    }, [errorText])
    const load = (wantRepos: boolean) => listFactoryProjectsAction(wantRepos).catch(thrown).then(apply)
    useEffect(() => { listFactoryProjectsAction(false).catch(thrown).then(apply) }, [apply])

    const active = projects?.find(p => p.active)?.repo ?? snapshot.repo
    const name = active.split('/').pop() || active
    const inFlight = snapshot.jobs.filter(j => groupOf(j.state) === 'active').length
    const known = new Set(projects?.map(p => p.repo))
    const reachable = snapshot.projects?.repos.filter(r => !known.has(r))

    const report = (text: string, failed: FactoryReadyLine[] = []) => { setStatus(text); setLines(failed) }

    const addRepo = async (repo: string) => {
        setBusy(true)
        const res = await addFactoryRepoAction(repo).catch(thrown)
        setBusy(false)
        report(res.ok ? t('added', { repo }) : errorText(res))
        if (res.ok) { setAdding(false); void load(false) }
    }

    const addPath = async () => {
        setBusy(true)
        report(t('checkingPath'))
        for (;;) {
            const res = await addFactoryPathAction(path).catch(thrown)
            if (!alive.current) return
            if (!res.ok) { report(errorText(res)); break }
            const o = res.outcome
            if (o.state === 'checking') { await sleep(POLL_MS); continue }
            if (o.state === 'added') { report(t('added', { repo: shownName(o.project) })); setPath(''); setAdding(false); void load(false) }
            else report(o.state === 'refused' ? t(`probe.${o.code}`) : t('timedOut'))
            break
        }
        setBusy(false)
    }

    const select = async (project: FactoryProject) => {
        setBusy(true)
        report(t('checkingReady', { repo: shownName(project) }))
        for (;;) {
            const res = await selectFactoryProjectAction(project.id).catch(thrown)
            if (!alive.current) return
            if (!res.ok) { report(errorText(res)); break }
            const o = res.outcome
            if (o.state === 'checking') { await sleep(POLL_MS); continue }
            if (o.state === 'selected') { report(t('selected', { repo: shownName(project) })); void load(false) }
            else if (o.state === 'refused') report(t('notReady', { repo: shownName(project) }), o.lines)
            else report(t('timedOut'))
            break
        }
        setBusy(false)
    }

    const remove = async (project: FactoryProject) => {
        setBusy(true)
        const res = await removeFactoryProjectAction(project.id).catch(thrown)
        setBusy(false)
        report(res.ok ? t('removed', { repo: shownName(project) }) : errorText(res))
        if (res.ok) void load(false)
    }

    const ask = (next: Confirm) => { setOpen(false); setConfirm(next) }
    const closeConfirm = (keep: boolean) => { if (!keep) { setConfirm(null); requestAnimationFrame(() => triggerRef.current?.focus()) } }

    return (
        <div data-project-picker className="flex min-w-0 flex-col items-center gap-1">
            <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) setAdding(false) }}>
                <TooltipLabeled label={<span className="flex flex-col gap-0.5"><span>{active}</span>{status && <span>{status}</span>}{lines.map(l => <span key={l.name}>{l.name}: {l.why}</span>)}</span>}>
                    <PopoverTrigger asChild>
                        <button ref={triggerRef} type="button" aria-label={t('trigger', { repo: active })}
                            className="flex max-w-[min(20rem,calc(100vw-2rem))] items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs hover:bg-accent">
                            <ProjectMark repo={active} />
                            <span className="min-w-0 truncate">{name}</span>
                            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        </button>
                    </PopoverTrigger>
                </TooltipLabeled>
                <PopoverContent align="start" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0">
                    {adding ? (
                        <div className="flex max-h-[min(28rem,70vh)] flex-col gap-3 overflow-y-auto p-3">
                            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setAdding(false)}>{t('back')}</Button>
                            <Command className="rounded-md border border-border/60">
                                <CommandInput placeholder={t('reposSearch')} aria-label={t('reposSearch')} />
                                <CommandList aria-label={t('reposHeading')} className="max-h-48">
                                    <CommandEmpty>{(snapshot.projects?.repos.length ?? 0) === 0 ? t('reposWaiting') : t('reposEmpty')}</CommandEmpty>
                                    <CommandGroup heading={t('reposHeading')}>
                                        {(reachable ?? []).map(repo => (
                                            <CommandItem key={repo} value={repo} disabled={busy} onSelect={() => void addRepo(repo)}>
                                                <ProjectMark repo={repo} />
                                                <span className="truncate">{repo}</span>
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                            <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); if (path.trim() && !busy) void addPath() }}>
                                <Field label={t('pathLabel')} htmlFor="factory-project-path">
                                    <Input id="factory-project-path" value={path} onChange={e => setPath(e.target.value)} placeholder={t('pathPlaceholder')} maxLength={4096} autoComplete="off" spellCheck={false} />
                                </Field>
                                <Button type="submit" size="sm" disabled={busy || !path.trim()} className="self-end">{t('pathAdd')}</Button>
                            </form>
                        </div>
                    ) : (
                        <div className="flex flex-col">
                            {loadError ? (
                                <div className="flex flex-col items-start gap-2 p-3 text-xs">
                                    <p>{t('loadFailed')}</p>
                                    <Button type="button" size="sm" variant="outline" onClick={() => void load(false)}>{t('retry')}</Button>
                                </div>
                            ) : projects === null ? (
                                <div className="flex flex-col gap-2 p-3" aria-hidden><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div>
                            ) : (
                                <Command>
                                    <CommandList aria-label={t('heading')} className="max-h-64">
                                        <CommandEmpty>{t('empty')}</CommandEmpty>
                                        <CommandGroup heading={t('heading')}>
                                            {projects.map(p => (
                                                <CommandItem key={p.id} value={shownName(p)} disabled={!isOwner || busy}
                                                    onSelect={() => { if (!p.active) ask({ kind: 'select', project: p }) }}>
                                                    <ProjectMark repo={shownName(p)} />
                                                    <span className="flex min-w-0 flex-1 flex-col">
                                                        <span className="truncate">{shownName(p)}</span>
                                                    </span>
                                                    {p.active && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{t('active')}</span>}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            )}
                            {isOwner && projects && projects.some(p => !p.active) && (
                                <ul className="flex flex-col border-t border-border/60 p-1" aria-label={t('removeHeading')}>
                                    {projects.filter(p => !p.active).map(p => (
                                        <li key={p.id}>
                                            <button type="button" disabled={busy} onClick={() => ask({ kind: 'remove', project: p })}
                                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
                                                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                                                <span className="truncate">{t('remove', { repo: shownName(p) })}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="border-t border-border/60 p-2">
                                {isOwner
                                    ? <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => { setAdding(true); void load(true) }}>{t('add')}</Button>
                                    : <p className="px-1 text-xs text-muted-foreground">{t('ownerOnly')}</p>}
                            </div>
                        </div>
                    )}
                </PopoverContent>
            </Popover>
            <div role="status" aria-live="polite" className="sr-only">
                {status && <span data-project-status>{status}</span>}
                {lines.length > 0 && (
                    <ul data-ready-lines className="text-left">
                        {lines.map(l => <li key={l.name}>{l.name}: {l.why}</li>)}
                    </ul>
                )}
            </div>
            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={closeConfirm}
                title={confirm?.kind === 'remove' ? t('confirmRemoveTitle', { repo: shownName(confirm.project) }) : t('confirmSelectTitle', { repo: confirm ? shownName(confirm.project) : '' })}
                description={confirm?.kind === 'remove' ? t('confirmRemoveBody') : t('confirmSelectBody', { count: inFlight, old: active })}
                confirmLabel={confirm?.kind === 'remove' ? t('confirmRemove') : t('confirmSelect')}
                confirmVariant={confirm?.kind === 'remove' ? 'destructive' : 'default'}
                onConfirm={() => {
                    const next = confirm
                    closeConfirm(false)
                    if (next?.kind === 'remove') void remove(next.project)
                    else if (next) void select(next.project)
                }}
            />
        </div>
    )
}
