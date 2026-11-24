'use client'

import type { FactorySnapshot } from '@moldwright/contracts'
import { formatDate } from '@moldwright/i18n/format'
import { ChromeBar, ChromeButton } from '@moldwright/ui/chrome'
import { IsoGrid, frameTemplateBoard, routeTileLinks, useRenderedFrame, type AxisPoint, type IsoCamera, type Tile } from '@moldwright/ui/iso-grid'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { fireMoldwrightConfetti } from '@/lib/confetti'
import { Button } from '@/components/ui/button'
import { FocusCenterIcon } from '@/lib/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipLabeled, TooltipTrigger } from '@/components/ui/tooltip'
import { applyMoves, canMove, copyTree, dropReason, layoutStorageKey, loadLayout, readMoves, saveLayout, subscribeLayout, treeRoutes } from './factory-layout'
import { type Bucket } from './factory-bucket'
import { METRICS, barModel, hasData, type MetricDef, type MetricGroup, type MetricKey, type MetricValues } from './factory-metrics'
import { FactoryBarFrame } from './FactoryBarFrame'
import { botCentre, floorFrame } from './factory-camera'
import { FactoryOverlay } from './FactoryOverlay'
import { LOOP_MS, factoryScene, type Cell, type FactoryFrame } from './factory-scene'

const OVERHEAD_PX = 120
const BAR_PX = 110
const BAR_MARGIN_PX = 20
const SIDE_PX = 40
const ZOOM_RANGE = { min: 0.1, max: 3 }
const ZOOM_STEP = 1.2

const TICK_MS = 250
const METRIC_GROUPS: MetricGroup[] = ['flow', 'cost', 'runs', 'plan']
const FOLDING_GROUPS: MetricGroup[] = ['cost', 'runs']

function useStable<T>(value: T): T {
    const key = JSON.stringify(value)
    const held = useRef({ key, value })
    if (held.current.key !== key) held.current = { key, value }
    return held.current.value
}

type SceneFn = (t: number, now: number) => FactoryFrame

function LiveOverlay({ start, tiles, routes, scene, selectedIssue, onSelectJob, onOpenBucket }: { start: number; tiles: Tile[]; routes: Map<string, AxisPoint[]>; scene: SceneFn; selectedIssue: number | null; onSelectJob: ((issue: number) => void) | undefined; onOpenBucket: ((bucket: Bucket) => void) | undefined }) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(id)
    }, [])
    const frame = scene((now - start) % LOOP_MS, now)
    return <FactoryOverlay tiles={tiles} routes={routes} pods={frame.pods} cabinets={frame.cabinets} plans={frame.plans ?? []} rejects={frame.rejects} held={frame.held} holdLeftMs={frame.holdLeftMs} links={frame.links} selectedIssue={selectedIssue} {...(onSelectJob ? { onSelectJob } : {})} {...(onOpenBucket ? { onOpenBucket } : {})} />
}

export function FactoryWorld({ theme = 'dark', scene = factoryScene, workspace = 'sample', selectedIssue = null, onSelectJob, onOpenBucket, onOpenCoworker, rightInset = 0, snapshot = null, topBar }: { theme?: 'light' | 'dark'; scene?: SceneFn; workspace?: string; selectedIssue?: number | null; onSelectJob?: (issue: number) => void; onOpenBucket?: (bucket: Bucket) => void; onOpenCoworker?: (name: string) => void; rightInset?: number; snapshot?: FactorySnapshot | null; topBar?: ReactNode }) {
    const t = useTranslations('factory.floor')
    const locale = useLocale()
    const [clock, setClock] = useState(() => ({ start: Date.now(), now: Date.now() }))
    const [expired, setExpired] = useState<Set<string>>(() => new Set())
    useEffect(() => {
        const id = setInterval(() => setClock(c => ({ ...c, now: Date.now() })), TICK_MS)
        return () => clearInterval(id)
    }, [])

    const loopAt = (clock.now - clock.start) % LOOP_MS
    const frame = useMemo(() => scene(loopAt, clock.now), [scene, loopAt, clock.now])
    const loop = Math.floor((clock.now - clock.start) / LOOP_MS)
    const toasts = useStable(frame.toasts.map(toast => ({ ...toast, id: `${toast.id}#${loop}` })).filter(toast => !expired.has(toast.id)).slice(-2))
    const sceneTiles = useStable(frame.tiles)
    const storageKey = layoutStorageKey(workspace)
    const saved = useSyncExternalStore(subscribeLayout, () => loadLayout(storageKey), () => null)
    const boxes = frame.containers
    const moves = useMemo(() => readMoves(saved, sceneTiles, boxes), [saved, sceneTiles, boxes])
    const belts = useStable(frame.links.filter(l => l.variant === 'belt').map(l => ({ source: l.source, target: l.target, variant: l.variant })))
    const tiles = useMemo(() => applyMoves(sceneTiles, moves, boxes, belts), [sceneTiles, moves, boxes, belts])
    const onTileMove = useCallback((id: string, cell: Cell) => {
        if (canMove(sceneTiles, moves, id, cell, boxes)) saveLayout(storageKey, { ...moves, [id]: cell })
    }, [sceneTiles, moves, storageKey, boxes])
    const canDropTile = useCallback((id: string, cell: Cell) => dropReason(sceneTiles, moves, id, cell, boxes), [sceneTiles, moves, boxes])
    const moved = Object.keys(moves).length > 0
    const links = useStable(frame.links)
    const tree = useMemo(() => copyTree(tiles, links), [tiles, links])
    const routes = useMemo(() => treeRoutes(routeTileLinks(tiles, tree), tree, links), [tiles, tree, links])
    const onToastExpire = useCallback((id: string) => setExpired(prev => new Set(prev).add(id)), [])
    const worldOverlay = useCallback(() => <LiveOverlay start={clock.start} tiles={tiles} routes={routes} scene={scene} selectedIssue={selectedIssue} onSelectJob={onSelectJob} onOpenBucket={onOpenBucket} />, [clock.start, tiles, routes, scene, selectedIssue, onSelectJob, onOpenBucket])
    const gridTiles = useMemo(() => (onOpenCoworker ? tiles.map(t => (t.style?.buddy ? { ...t, selectable: true } : t)) : tiles), [tiles, onOpenCoworker])
    const onTileSelect = useCallback((id: string | null) => { if (id && onOpenCoworker) onOpenCoworker(id) }, [onOpenCoworker])

    const fullCabinets = frame.cabinets.filter(c => c.slots.every(s => s.state !== 'empty')).length
    const full = useRef(fullCabinets)
    useEffect(() => {
        if (fullCabinets > full.current) void fireMoldwrightConfetti()
        full.current = fullCabinets
    }, [fullCabinets])

    const { ref, frame: size } = useRenderedFrame()
    const { ref: barRef, frame: bar } = useRenderedFrame()
    const { ref: topRef, frame: top } = useRenderedFrame()
    const corners = useMemo(() => frame.containers.flatMap(c => [
        { id: `${c.id}-a`, position: { col: c.col_start, row: c.row_start }, span: 1, style: { color: '' } },
        { id: `${c.id}-b`, position: { col: c.col_end, row: c.row_end }, span: 1, style: { color: '' } },
        { id: `${c.id}-c`, position: { col: c.col_end, row: c.row_start }, span: 1, style: { color: '' } },
        { id: `${c.id}-d`, position: { col: c.col_start, row: c.row_end }, span: 1, style: { color: '' } },
    ] as Tile[]), [frame.containers])
    const barSpace = bar ? bar.height + 2 * BAR_MARGIN_PX : BAR_PX
    const topSpace = topBar ? (top ? top.height + 2 * BAR_MARGIN_PX : BAR_PX) : 0
    const floor = useMemo(() => (size ? floorFrame({ stage: size, rightInset, topSpace, bottomSpace: barSpace, overhead: OVERHEAD_PX, side: SIDE_PX }) : null), [size, rightInset, barSpace, topSpace])
    const fitZoom = useMemo(() => (floor ? frameTemplateBoard(corners, floor, 2, 0.94, ZOOM_RANGE.min).zoom : null), [floor, corners])

    const [camera, setCamera] = useState<IsoCamera | null>(null)
    const [zoom, setZoom] = useState(1)
    const view = useRef<IsoCamera | null>(null)
    useEffect(() => { if (camera) view.current = camera }, [camera])
    const onCameraChange = useCallback((c: IsoCamera) => { view.current = c; setZoom(c.zoom) }, [])
    const centred = (z: number) => {
        const c = botCentre({ tiles, pods: frame.pods, routes, floor: frame.containers })
        return { x: -c.x + (floor?.shiftX ?? 0) / z, y: -c.y + (floor?.shiftY ?? 0) / z }
    }
    const show = (next: IsoCamera) => {
        setZoom(next.zoom)
        setCamera(prev => ({ ...next, nonce: (prev?.nonce ?? 0) + 1 }))
    }
    const zoomTo = (z: number) => {
        const at = view.current ?? camera
        if (at) show({ zoom: Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, z)), pan: at.pan })
    }
    const centre = () => {
        const z = view.current?.zoom ?? zoom
        show({ zoom: z, pan: centred(z) })
    }
    const frameKey = floor && fitZoom !== null ? `${floor.width}x${floor.height}@${floor.shiftX},${floor.shiftY}:${snapshot ? 'live' : 'sample'}` : null
    const [framed, setFramed] = useState<string | null>(null)
    if (frameKey !== null && fitZoom !== null && frameKey !== framed) {
        setFramed(frameKey)
        show({ zoom: fitZoom, pan: centred(fitZoom) })
    }
    const onMapKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return
        const z = view.current?.zoom ?? zoom
        if (e.key === '+' || e.key === '=') zoomTo(z * ZOOM_STEP)
        else if (e.key === '-' || e.key === '_') zoomTo(z / ZOOM_STEP)
        else if (e.key === '0') centre()
        else return
        e.preventDefault()
    }

    const stale = frame.notAnswering === true && snapshot !== null
    const asOf = stale ? t('asOf', { time: formatDate(snapshot.madeAt, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }) : undefined
    const { sample, values } = barModel({ snapshot, counts: frame.counts, held: frame.held, now: clock.now, start: clock.start })
    const noData = METRICS.filter(m => !hasData(values[m.key]))
    const groups = METRIC_GROUPS.map(group => ({ group, metrics: METRICS.filter(m => m.group === group && hasData(values[m.key])) })).filter(g => g.metrics.length > 0)
    const folded = groups.filter(g => FOLDING_GROUPS.includes(g.group)).flatMap(g => g.metrics)
    const tile = (m: MetricDef) => <Metric key={m.key} def={m} value={values[m.key]} {...(m.key === 'building' && asOf ? { asOf } : {})} />

    return (
        <div ref={ref} className={`${theme} relative h-full w-full overflow-hidden bg-background text-foreground`} style={{ '--factory-drop-max': `${size ? size.height - topSpace - barSpace : 0}px` } as CSSProperties}>
            <div data-factory-map role="region" tabIndex={0} aria-label={t('map')} onKeyDown={onMapKey}
                className="absolute inset-0 overflow-hidden outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50">
            <IsoGrid
                {...(stale ? { className: 'opacity-50' } : {})}
                tiles={gridTiles}
                containers={frame.containers}
                liveLinks={tree}
                toasts={toasts}
                onToastExpire={onToastExpire}
                camera={camera}
                cameraTransitionMs={0}
                onCameraChange={onCameraChange}
                zoomRange={ZOOM_RANGE}
                showLinks
                onTileMove={onTileMove}
                canDropTile={canDropTile}
                selectedTileId={null}
                {...(onOpenCoworker ? { onTileSelect } : {})}
                scrollGestures
                worldOverlay={worldOverlay}
            />
            </div>

            <ChromeBar data-map-view className="absolute z-30 px-1" style={{ left: BAR_MARGIN_PX, bottom: barSpace }}>
                <input type="range" aria-label={t('zoom')} min={ZOOM_RANGE.min} max={ZOOM_RANGE.max} step={0.05} value={zoom}
                    onChange={e => zoomTo(Number(e.currentTarget.value))}
                    className="mx-2 h-1 w-24 cursor-pointer rounded-full accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
                <TooltipLabeled label={t('centerHint')}>
                    <ChromeButton aria-label={t('center')} icon={FocusCenterIcon} onClick={centre} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
                </TooltipLabeled>
            </ChromeBar>

            <FactoryBarFrame edge="bottom" rightInset={rightInset} frameRef={barRef} className="items-stretch gap-4 px-5 py-3">
                <div className="flex shrink-0 items-center gap-2 pr-1">
                    <span className={`size-2 rounded-full ${stale ? 'bg-amber-500' : frame.held ? 'bg-red-500' : 'animate-pulse bg-emerald-500 motion-reduce:animate-none'}`} />
                    {noData.length > 0 ? (
                        <TooltipLabeled label={t('noData', { metrics: noData.map(m => m.label).join(', ') })}>
                            <span data-no-data tabIndex={0} className="rounded-sm text-sm font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">Factory</span>
                        </TooltipLabeled>
                    ) : <span className="text-sm font-semibold tracking-tight">Factory</span>}
                    {stale && <span data-last-beat className="text-[10px] text-amber-600 dark:text-amber-400">{t('lastBeat', { minutes: Math.max(1, Math.floor((frame.lastBeatMs ?? 0) / 60_000)) })}</span>}
                    {sample && <span className="text-[10px] text-muted-foreground">sample</span>}
                </div>
                {groups.map(({ group, metrics }) => (
                    <div key={group} data-metric-group={group} className={`flex shrink-0 items-center gap-4 border-l border-border/70 pl-4${FOLDING_GROUPS.includes(group) ? ' @max-[1100px]:hidden' : ''}`}>
                        {metrics.map(tile)}
                    </div>
                ))}
                {folded.length > 0 && (
                    <div className="hidden shrink-0 items-center border-l border-border/70 pl-4 @max-[1100px]:flex">
                        <Popover>
                            <PopoverTrigger asChild>
                                <button type="button" data-more-metrics aria-label={t('moreMetrics', { count: folded.length })}
                                    className="flex flex-col items-center justify-center rounded-sm leading-none outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">
                                    <span className="font-mono text-base font-semibold tabular-nums">+{folded.length}</span>
                                    <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('moreLabel')}</span>
                                </button>
                            </PopoverTrigger>
                            <PopoverContent side="top" align="start" sideOffset={8} className="w-auto flex-row gap-4 rounded-2xl border border-border/60 bg-background/95 p-3 backdrop-blur-xl">
                                {folded.map(tile)}
                            </PopoverContent>
                        </Popover>
                    </div>
                )}
                {moved && (
                    <div className="flex items-center border-l border-border/70 pl-4">
                        <Button type="button" variant="outline" size="sm" onClick={() => saveLayout(storageKey, null)}>
                            Reset layout
                        </Button>
                    </div>
                )}
            </FactoryBarFrame>

            {topBar && (
                <FactoryBarFrame edge="top" rightInset={rightInset} frameRef={topRef} className="h-11 w-[calc(100%-2.5rem)] items-center px-3 py-1.5">
                    {topBar}
                </FactoryBarFrame>
            )}
        </div>
    )
}

const TONES: Partial<Record<MetricKey, string>> = { building: 'text-amber-500', review: 'text-emerald-500', checks: 'text-sky-500', solvedGreen: 'text-green-500' }

function Metric({ def, value, asOf }: { def: MetricDef; value: MetricValues[MetricKey]; asOf?: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex cursor-help flex-col items-center justify-center leading-none" tabIndex={0} {...(value.title ? { title: value.title } : {})}>
                    <span className={`font-mono text-base font-semibold tabular-nums ${value.warn ? 'text-destructive' : (TONES[def.key] ?? 'text-foreground')}`}>{value.text}</span>
                    {value.fill !== undefined && (
                        <span className="mt-1 h-1 w-14 overflow-hidden rounded-full bg-muted">
                            <span className={`block h-full rounded-full transition-all duration-700 ${value.warn ? 'bg-red-500' : 'bg-[#4d34f7]'}`} style={{ width: `${value.fill}%` }} />
                        </span>
                    )}
                    <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{def.label}</span>
                    {asOf && <span data-as-of className="mt-0.5 text-[10px] text-muted-foreground">{asOf}</span>}
                </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
                <p>{def.definition}</p>
                <p className="mt-1 opacity-70">Source: {def.source}</p>
            </TooltipContent>
        </Tooltip>
    )
}
