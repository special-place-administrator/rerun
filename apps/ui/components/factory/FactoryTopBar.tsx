'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Activity } from 'lucide-react'
import type { FactoryDepartment, FactorySnapshot } from '@moldwright/contracts'
import { formatDate } from '@moldwright/i18n/format'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BAR_TIERS } from './factory-bar-tiers'
import { FactoryBucket } from './FactoryBucket'
import { FactoryInspector } from './FactoryInspector'
import { FactoryLedger } from './FactoryLedger'
import { FactoryProjectPicker } from './FactoryProjectPicker'
import { FactoryRunControl } from './FactoryRunControl'
import { FactoryStatePill } from './FactoryStatePill'
import { FactoryPoolMenu, FactoryPoolPick } from './FactoryThrottle'
import { FactoryWorkOrders, FactoryWorkOrdersSkeleton } from './FactoryWorkOrders'
import { SAMPLE_TEXT } from './FactoryTasks'
import { type Bucket } from './factory-bucket'
import { isAnswering } from './factory-loader'
import { DEPARTMENT_VIEW, buildLedger, chipCounts, filterLedger, waitingInOrder, type ChipCounts, type LedgerFilter } from './factory-ledger'
import { throttleShown } from './factory-throttle'
import type { FactoryControlsState } from './use-factory-controls'

type MainChip = 'running' | 'waiting' | 'problems' | 'doneToday'
const MAIN_CHIPS: { key: MainChip; label: string }[] = [
    { key: 'running', label: 'Running' },
    { key: 'waiting', label: 'Waiting' },
    { key: 'problems', label: 'Problems' },
    { key: 'doneToday', label: 'Done today' },
]
const FOLDING_CHIPS: MainChip[] = ['waiting', 'doneToday']

const ROW = 'flex h-full w-full min-w-0 flex-nowrap items-center gap-3'
const ZONE = 'flex shrink-0 items-center gap-2 self-stretch'
const DIVIDED = 'border-l border-border/60 pl-3'
const CHIP = 'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-xs outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50'

const sameFilter = (a: LedgerFilter | null, b: LedgerFilter) =>
    a !== null && (typeof a === 'string' || typeof b === 'string' ? a === b : a.department === b.department)

function Chip({ name, label, count, filter, active, onPress, color, asOf, note, className }: {
    name: string; label: string; count?: number | string; filter: LedgerFilter; active: boolean; onPress: (f: LedgerFilter, chip: HTMLElement) => void; color?: string; asOf?: string | undefined; note?: string | undefined; className?: string
}) {
    return (
        <button
            type="button"
            data-chip={name}
            aria-pressed={active}
            onClick={e => onPress(filter, e.currentTarget)}
            className={cn(CHIP, active ? 'border-foreground/40 bg-accent font-medium' : 'border-border/60 text-muted-foreground', className)}
        >
            {color && <span className="size-2 rounded-full" style={{ background: color }} />}
            {label}{count !== undefined ? ` ${count}` : ''}
            {asOf && <span data-as-of className="text-muted-foreground">{asOf}</span>}
            {note && <span data-chip-note className="text-muted-foreground">{note}</span>}
        </button>
    )
}

export function FactoryTopBar({ snapshot, controls, selected, onSelect, names, onOpenCoworker, bucket = null, onBucket, context, action, rightInset = 0 }: {
    snapshot: FactorySnapshot | null
    controls: FactoryControlsState
    selected: number | null
    onSelect: (issue: number | null) => void
    names: Record<string, string>
    onOpenCoworker: (coworkerId: string) => void
    bucket?: Bucket | null
    onBucket?: (bucket: Bucket | null) => void
    context?: ReactNode
    action?: ReactNode
    rightInset?: number
}) {
    const t = useTranslations('factory.floor')
    const locale = useLocale()
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [])
    const [filter, setFilter] = useState<LedgerFilter | null>(null)
    const tOrders = useTranslations('factory.orders')
    const [moreOpen, setMoreOpen] = useState(false)
    const [activityOpen, setActivityOpen] = useState(false)
    const [projectsOpen, setProjectsOpen] = useState(false)
    const [ordersOpen, setOrdersOpen] = useState(false)
    const [root, setRoot] = useState<HTMLDivElement | null>(null)
    const pressedRef = useRef<HTMLElement | null>(null)
    const statusRef = useRef<HTMLDivElement>(null)
    const moreRef = useRef<HTMLButtonElement>(null)
    const activityRef = useRef<HTMLButtonElement>(null)
    const open = snapshot !== null && (filter !== null || selected !== null || bucket !== null)

    const close = useCallback(() => {
        setFilter(null)
        onSelect(null)
        onBucket?.(null)
    }, [onSelect, onBucket])

    useEffect(() => {
        if (!open || !root) return
        const onDown = (e: Event) => {
            if (e.target instanceof Node && root.contains(e.target)) return
            close()
        }
        document.addEventListener('pointerdown', onDown)
        return () => document.removeEventListener('pointerdown', onDown)
    }, [open, root, close])

    const epics = useMemo(() => (snapshot ? buildLedger(snapshot) : []), [snapshot])
    const counts: ChipCounts = useMemo(() => chipCounts(epics, now), [epics, now])
    const shownEpics = useMemo(() => filterLedger(epics, filter, now), [epics, filter, now])
    const press = (f: LedgerFilter, chip?: HTMLElement | null) => {
        if (chip) pressedRef.current = chip
        onBucket?.(null)
        setFilter(cur => (sameFilter(cur, f) ? null : f))
    }

    const actionZone = action && <div data-zone="action" className={cn(ZONE, DIVIDED, 'ml-auto', BAR_TIERS.t3.undivided)}>{action}</div>
    if (!snapshot) {
        return (
            <div data-topbar className={ROW}>
                {context && <div data-zone="context" className={ZONE}>{context}</div>}
                <div data-zone="status" className={cn(ZONE, 'min-w-0 shrink', context && DIVIDED)}>
                    <span className="truncate text-xs text-muted-foreground">{SAMPLE_TEXT}</span>
                </div>
                {actionZone}
            </div>
        )
    }

    const job = snapshot.jobs.find(j => j.issue === selected) ?? null
    const asOf = isAnswering(snapshot.madeAt, now) ? undefined : t('asOf', { time: formatDate(snapshot.madeAt, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })
    const departments = (Object.keys(counts.byDepartment) as FactoryDepartment[]).filter(d => (counts.byDepartment[d] ?? 0) > 0)
    const { running, pool } = throttleShown(snapshot, controls.view)
    const order = snapshot.work_order
    const inOrder = order ? waitingInOrder(epics, order.issues) : null
    const countOf = (key: MainChip) => (key === 'running' ? `${running}/${pool}` : key === 'waiting' && inOrder !== null ? inOrder : counts[key])
    const noteOf = (key: MainChip) => (key === 'waiting' && inOrder !== null ? t('waitingOutside', { count: counts.waiting - inOrder }) : undefined)
    const folded = MAIN_CHIPS.filter(c => FOLDING_CHIPS.includes(c.key))
    const problemsDot = counts.problems > 0 ? { color: 'var(--destructive)' } : {}
    const activityText = t('activity', { running, pool, problems: counts.problems })
    const repo = controls.view?.activeRepo ?? null
    const orderActive = repo !== null && (controls.view?.orders ?? []).some(o => o.repo === repo && o.status === 'active')
    const moreControls = () => root?.querySelector<HTMLElement>('[data-more-controls]')
    const ledgerAnchor = {
        current: {
            getBoundingClientRect: () => {
                const at = (filter !== null ? pressedRef.current : statusRef.current)?.getBoundingClientRect() ?? new DOMRect()
                const frame = root?.parentElement?.getBoundingClientRect() ?? at
                return new DOMRect(at.left, frame.top, at.width, frame.height)
            },
        },
    }
    const orderItem = (afterClose: (open: () => void) => void) => controls.view === null ? null : repo === null ? (
        <DropdownMenuItem data-needs-project className="flex-col items-start gap-0.5" onSelect={() => afterClose(() => setProjectsOpen(true))}>
            <span>{tOrders('needsProject')}</span>
            <span className="text-xs text-muted-foreground">{tOrders('needsProjectWhy')}</span>
        </DropdownMenuItem>
    ) : (
        <DropdownMenuItem data-order-item onSelect={() => afterClose(() => setOrdersOpen(true))}>{orderActive ? tOrders('trigger') : tOrders('triggerAsk')}</DropdownMenuItem>
    )

    return (
        <div ref={setRoot} data-topbar className={ROW}>
            <div data-zone="context" className={ZONE}>
                {context}
                <div className={cn('min-w-0 max-w-50 [&>[data-project-picker]>button]:max-w-full', BAR_TIERS.t3.repo)}>
                    <FactoryProjectPicker snapshot={snapshot} open={projectsOpen} onOpenChange={setProjectsOpen} />
                </div>
                {controls.view === null && controls.loadError === null
                    ? <div className={cn('flex', BAR_TIERS.t2.hide)}><FactoryWorkOrdersSkeleton /></div>
                    : <FactoryWorkOrders snapshot={snapshot} controls={controls} open={ordersOpen} onOpenChange={setOrdersOpen} fallback={moreControls} onPickProject={() => setProjectsOpen(true)} className={BAR_TIERS.t2.hide} />}
            </div>
            <div data-zone="controls" className={cn(ZONE, DIVIDED)}>
                <FactoryRunControl snapshot={snapshot} controls={controls} moreItems={afterClose => <>{orderItem(afterClose)}<FactoryPoolMenu snapshot={snapshot} controls={controls} /></>} />
                <div className={cn('flex shrink-0', BAR_TIERS.t2.hide)}><FactoryPoolPick snapshot={snapshot} controls={controls} /></div>
            </div>
            <div ref={statusRef} data-zone="status" className={cn(ZONE, DIVIDED)}>
                <FactoryStatePill snapshot={snapshot} controls={controls} now={now} onProjects={() => setProjectsOpen(true)} onChooseWork={() => setOrdersOpen(true)} />
                {MAIN_CHIPS.map(c => (
                    <Chip key={c.key} name={c.key} label={c.label} count={countOf(c.key)} filter={c.key} active={sameFilter(filter, c.key)} onPress={press}
                        asOf={c.key === 'running' ? asOf : undefined} note={noteOf(c.key)} className={FOLDING_CHIPS.includes(c.key) ? BAR_TIERS.t1.hide : BAR_TIERS.t3.hide}
                        {...(c.key === 'problems' ? problemsDot : {})} />
                ))}
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                    <PopoverTrigger asChild>
                        <button ref={moreRef} type="button" data-more-chips aria-label={t('moreChips', { count: folded.length })}
                            className={cn(CHIP, 'hidden border-border/60 text-muted-foreground', BAR_TIERS.t1.show, BAR_TIERS.t3.hide)}>
                            +{folded.length}
                        </button>
                    </PopoverTrigger>
                    <PopoverContent container={root} side="bottom" align="end" sideOffset={8} className="w-auto flex-row gap-2 p-2">
                        {folded.map(c => (
                            <Chip key={c.key} name={c.key} label={c.label} count={countOf(c.key)} note={noteOf(c.key)} filter={c.key} active={sameFilter(filter, c.key)}
                                onPress={f => { setMoreOpen(false); press(f, moreRef.current) }} />
                        ))}
                    </PopoverContent>
                </Popover>
                <Popover open={activityOpen} onOpenChange={setActivityOpen}>
                    <TooltipLabeled label={activityText}>
                        <PopoverTrigger asChild>
                            <button ref={activityRef} type="button" data-activity aria-label={t('activityName', { problems: counts.problems })}
                                className={cn(CHIP, 'hidden justify-center border-border/60 text-muted-foreground', BAR_TIERS.t3.show, BAR_TIERS.t3.square)}>
                                <span aria-hidden className="relative">
                                    <Activity className="size-4" />
                                    {counts.problems > 0 && <span className="absolute -right-1 -top-1 size-2 rounded-full" style={{ background: 'var(--destructive)' }} />}
                                </span>
                            </button>
                        </PopoverTrigger>
                    </TooltipLabeled>
                    <PopoverContent container={root} side="bottom" align="start" sideOffset={8} className="w-auto gap-1 p-2">
                        {MAIN_CHIPS.map(c => (
                            <Chip key={c.key} name={c.key} label={c.label} count={countOf(c.key)} note={noteOf(c.key)} filter={c.key} active={sameFilter(filter, c.key)}
                                onPress={f => { setActivityOpen(false); press(f, activityRef.current) }} {...(c.key === 'problems' ? problemsDot : {})} />
                        ))}
                    </PopoverContent>
                </Popover>
            </div>
            {actionZone}
            <Popover open={open} onOpenChange={next => { if (!next) close() }}>
                <PopoverAnchor virtualRef={ledgerAnchor} />
                <PopoverContent
                    container={root}
                    data-dropdown
                    side="bottom"
                    align="start"
                    sideOffset={8}
                    collisionPadding={{ left: 20, right: rightInset + 20 }}
                    onOpenAutoFocus={e => e.preventDefault()}
                    onCloseAutoFocus={e => e.preventDefault()}
                    onInteractOutside={e => e.preventDefault()}
                    style={{ maxHeight: 'var(--factory-drop-max)' }}
                    className="w-[min(40rem,calc(100cqw-2.5rem))] gap-0 overflow-y-auto rounded-2xl border border-border/60 bg-background/95 p-3 text-foreground shadow-[0_8px_40px_rgba(0,0,0,0.12)] ring-0 backdrop-blur-xl"
                >
                    {selected !== null ? (
                        <div className="flex flex-col gap-2">
                            <button type="button" onClick={() => onSelect(null)} className="self-start rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent">Back to the list</button>
                            <FactoryInspector job={job} jobs={snapshot.jobs} repo={snapshot.repo} names={names} onSelect={onSelect} onOpenCoworker={onOpenCoworker} />
                        </div>
                    ) : bucket !== null ? (
                        <FactoryBucket bucket={bucket} jobs={snapshot.jobs} repo={snapshot.repo} names={names} now={now} onSelect={onSelect} />
                    ) : (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <Chip name="wave" label="This wave" filter="wave" active={sameFilter(filter, 'wave')} onPress={f => press(f)} />
                                {departments.map(d => (
                                    <Chip key={d} name={d} label={DEPARTMENT_VIEW[d].label} count={counts.byDepartment[d]} filter={{ department: d }} active={sameFilter(filter, { department: d })} onPress={f => press(f)} color={DEPARTMENT_VIEW[d].color} />
                                ))}
                            </div>
                            <FactoryLedger epics={shownEpics} repo={snapshot.repo} selected={selected} onSelect={onSelect} now={now} />
                        </div>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    )
}
