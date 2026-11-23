'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { FACTORY_ORDER_KINDS, FACTORY_ORDER_TEXT_MAX, type FactoryOrderKind, type FactorySnapshot } from '@moldwright/contracts'
import { actOnFactoryWorkOrderAction, cancelFactoryWorkOrderAction, createFactoryWorkOrderAction } from '@/app/api/_actions/factory.actions'
import type { ActionResult } from '@/app/api/_actions/space.actions'
import type { FactoryWorkOrder, WorkOrderAction } from '@/app/api/_services/factory-controls.service'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useErrorText } from '@/hooks/useErrorText'
import { groupOf } from './factory-state'
import { thrown, type FactoryControlsState } from './use-factory-controls'

const issueList = (text: string): number[] => [...new Set((text.match(/\d+/g) ?? []).map(Number).filter(n => n > 0))]
const openIssues = (snapshot: FactorySnapshot): string => snapshot.jobs.filter(j => groupOf(j.state) !== 'ended').map(j => j.issue).join(', ')
const hashes = (issues: number[]): string => issues.map(n => `#${n}`).join(', ')
type Confirm = { kind: 'replace' } | { kind: 'cancel'; order: FactoryWorkOrder } | null

export function FactoryWorkOrders({ snapshot, controls }: { snapshot: FactorySnapshot; controls: FactoryControlsState }) {
    const t = useTranslations('factory.orders')
    const errorText = useErrorText()
    const { view, loadError, reload } = controls
    const [open, setOpen] = useState(false)
    const [kind, setKind] = useState<FactoryOrderKind>('feature')
    const [text, setText] = useState('')
    const [issue, setIssue] = useState('')
    const [issues, setIssues] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState('')
    const [confirm, setConfirm] = useState<Confirm>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)

    const repo = view?.activeRepo
    if (!repo) return null
    const orders = view.orders.filter(o => o.repo === repo)
    const active = orders.find(o => o.status === 'active') ?? null
    const reported = snapshot.work_order?.id ? snapshot.work_order : null
    const issuesText = issues ?? openIssues(snapshot)
    const picked = kind === 'issue' ? issueList(issue).slice(0, 1) : kind === 'all_issues' ? issueList(issuesText) : []
    const ready = kind === 'feature' || kind === 'bug' ? text.trim().length > 0 : picked.length > 0

    const run = async (work: () => Promise<ActionResult<object>>, done: string): Promise<boolean> => {
        setBusy(true)
        setStatus('')
        const res = await work().catch(thrown)
        setBusy(false)
        setStatus(res.ok ? done : errorText(res))
        if (res.ok) await reload()
        return res.ok
    }
    const submit = async () => {
        const sent = await run(() => createFactoryWorkOrderAction({ repo, kind, issues: picked, text }), t('sent'))
        if (sent) { setText(''); setIssue(''); setIssues(null) }
    }
    const act = (order: FactoryWorkOrder, action: WorkOrderAction, n: number) =>
        void run(() => actOnFactoryWorkOrderAction(order.id, action, n), t('actionSent', { action, issue: n }))
    const ask = (next: Confirm) => { setOpen(false); setConfirm(next) }
    const closeConfirm = (keep: boolean) => { if (!keep) { setConfirm(null); requestAnimationFrame(() => triggerRef.current?.focus()) } }

    return (
        <div data-work-orders className="flex min-w-0 flex-col items-center gap-1">
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <button ref={triggerRef} type="button" aria-label={active ? t('trigger') : t('ask', { repo })}
                        className="flex max-w-[min(20rem,calc(100vw-2rem))] items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs hover:bg-accent">
                        <span className="truncate">{active ? t('trigger') : t('triggerAsk')}</span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={8} className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0">
                    <div className="flex max-h-[min(36rem,75vh)] flex-col gap-3 overflow-y-auto p-3 text-xs">
                        <p className="text-sm font-medium">{t('ask', { repo })}</p>
                        {view.isOwner ? (
                            <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (ready && !busy) { if (active) ask({ kind: 'replace' }); else void submit() } }}>
                                <div role="group" aria-label={t('kindLabel')} className="flex flex-wrap gap-1">
                                    {FACTORY_ORDER_KINDS.map(k => (
                                        <Button key={k} type="button" size="xs" variant={kind === k ? 'default' : 'outline'} aria-pressed={kind === k} data-order-kind={k} onClick={() => setKind(k)}>
                                            {t('kind', { kind: k })}
                                        </Button>
                                    ))}
                                </div>
                                {(kind === 'feature' || kind === 'bug') && (
                                    <Field label={t('textLabel', { kind })} htmlFor="factory-order-text">
                                        <Textarea id="factory-order-text" value={text} onChange={e => setText(e.target.value)} maxLength={FACTORY_ORDER_TEXT_MAX} rows={4} />
                                    </Field>
                                )}
                                {kind === 'issue' && (
                                    <Field label={t('issueLabel')} htmlFor="factory-order-issue">
                                        <Input id="factory-order-issue" inputMode="numeric" value={issue} onChange={e => setIssue(e.target.value)} placeholder="123" autoComplete="off" />
                                    </Field>
                                )}
                                {kind === 'all_issues' && (
                                    <Field label={t('issuesLabel')} htmlFor="factory-order-issues">
                                        <Textarea id="factory-order-issues" value={issuesText} onChange={e => setIssues(e.target.value)} rows={3} aria-describedby="factory-order-issues-hint" />
                                        <span id="factory-order-issues-hint" className="text-[11px] text-muted-foreground">{t('issuesHint', { count: picked.length })}</span>
                                    </Field>
                                )}
                                {(kind === 'feature' || kind === 'bug') && <p className="text-[11px] text-muted-foreground">{t('describedWaits')}</p>}
                                <Button type="submit" size="sm" disabled={busy || !ready} aria-busy={busy} className="self-end">{t('submit')}</Button>
                            </form>
                        ) : (
                            <p className="text-muted-foreground">{t('ownerOnly')}</p>
                        )}
                        <section aria-label={t('listHeading', { repo })} className="flex flex-col gap-2 border-t border-border/60 pt-3">
                            <h3 className="font-medium text-muted-foreground">{t('listHeading', { repo })}</h3>
                            {loadError ? (
                                <div className="flex items-center gap-2">
                                    <span>{t('loadFailed')}</span>
                                    <Button type="button" size="xs" variant="outline" onClick={() => void reload()}>{t('retryLoad')}</Button>
                                </div>
                            ) : orders.length === 0 ? (
                                <p className="text-muted-foreground">{t('empty')}</p>
                            ) : (
                                <ul className="flex flex-col gap-2">
                                    {orders.map(o => (
                                        <OrderRow key={o.id} order={o} reported={reported?.id === o.id ? reported : null} isOwner={view.isOwner} busy={busy}
                                            onCancel={() => ask({ kind: 'cancel', order: o })} onAct={(action, n) => act(o, action, n)} />
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </PopoverContent>
            </Popover>
            <div role="status" aria-live="polite" className="max-w-[min(28rem,calc(100vw-2rem))] text-center text-xs text-muted-foreground">
                {reported?.halted && <span data-order-halted>{t('halted', { issue: reported.halted })}</span>}
                {status && <span data-order-status>{status}</span>}
            </div>
            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={closeConfirm}
                title={confirm?.kind === 'cancel' ? t('cancelTitle') : t('replaceTitle')}
                description={confirm?.kind === 'cancel' ? t('cancelBody') : t('replaceBody')}
                confirmLabel={confirm?.kind === 'cancel' ? t('cancelConfirm') : t('replaceConfirm')}
                confirmVariant={confirm?.kind === 'cancel' ? 'destructive' : 'default'}
                onConfirm={() => {
                    const next = confirm
                    closeConfirm(false)
                    if (next?.kind === 'cancel') void run(() => cancelFactoryWorkOrderAction(next.order.id), t('cancelled'))
                    else if (next) void submit()
                }}
            />
        </div>
    )
}

export function FactoryWorkOrdersSkeleton() {
    return <Skeleton className="h-6 w-32 rounded-full" aria-hidden />
}

function OrderRow({ order, reported, isOwner, busy, onCancel, onAct }: {
    order: FactoryWorkOrder
    reported: NonNullable<FactorySnapshot['work_order']> | null
    isOwner: boolean
    busy: boolean
    onCancel: () => void
    onAct: (action: WorkOrderAction, issue: number) => void
}) {
    const t = useTranslations('factory.orders')
    const live = order.status === 'active'
    return (
        <li data-order={order.id} className="flex flex-col gap-1 rounded-md border border-border/60 p-2">
            <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t('kind', { kind: order.kind })}</span>
                <span className="shrink-0 text-muted-foreground">{t('status', { status: order.status })}</span>
            </div>
            {order.text && <p className="line-clamp-3 break-words text-muted-foreground">{order.text}</p>}
            {order.issues.length > 0 && <p className="break-words text-muted-foreground">{hashes(order.issues)}</p>}
            {live && !reported && <p className="text-muted-foreground">{t('notPickedUp')}</p>}
            {live && reported && (
                <div className="flex flex-col gap-0.5 text-muted-foreground" data-order-progress>
                    {reported.current !== null && <span>{t('current', { issue: reported.current })}</span>}
                    <span>{t('done', { count: reported.done.length })}</span>
                    {reported.skipped.length > 0 && <span>{t('skipped', { count: reported.skipped.length })}</span>}
                    {reported.wait && <span data-order-wait>{reported.wait}</span>}
                </div>
            )}
            {live && isOwner && (
                <div className="flex flex-wrap justify-end gap-1">
                    {reported?.halted && (
                        <>
                            <Button type="button" size="xs" disabled={busy} aria-busy={busy} onClick={() => onAct('retry', reported.halted as number)}>{t('retry', { issue: reported.halted })}</Button>
                            <Button type="button" size="xs" variant="outline" disabled={busy} aria-busy={busy} onClick={() => onAct('skip', reported.halted as number)}>{t('skip', { issue: reported.halted })}</Button>
                        </>
                    )}
                    <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
                </div>
            )}
        </li>
    )
}
