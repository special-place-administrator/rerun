'use client'

import { useLocale, useTranslations } from 'next-intl'
import { FACTORY_CONTROL_DEFAULT, type FactoryControlState, type FactorySnapshot } from '@moldwright/contracts'
import { formatDate } from '@moldwright/i18n/format'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { liveHold } from './from-snapshot'
import type { FactoryControlsState } from './use-factory-controls'

const NO_PROVIDER = 'no enabled provider'
const NO_WORK = 'no work'
const WAITS: Record<string, 'project' | 'order' | 'done'> = { 'no project chosen': 'project', 'no work order': 'order', 'the work order is done': 'done' }
const ACTION = 'flex shrink-0 items-center whitespace-nowrap rounded-full border border-border/60 px-3 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50'
const DOT: Record<FactoryControlState, string> = { RUNNING: 'bg-emerald-500', PAUSED: 'bg-amber-500', DRAINING: 'bg-amber-500', STOPPED: 'bg-red-500' }

export function FactoryStatePill({ snapshot, controls, now, onProjects, onChooseWork }: { snapshot: FactorySnapshot; controls: FactoryControlsState; now: number; onProjects?: () => void; onChooseWork?: () => void }) {
    const t = useTranslations('factory.controls')
    const tProjects = useTranslations('factory.projects')
    const tOrders = useTranslations('factory.orders')
    const locale = useLocale()
    const reported = snapshot.control?.state ?? FACTORY_CONTROL_DEFAULT
    const asked = controls.view?.state ?? null
    const waiting = snapshot.jobs.filter(j => j.reason === NO_PROVIDER).length
    const hold = liveHold(snapshot, now)
    const waitText = reported === 'RUNNING' && (!hold || hold.kind === NO_WORK) ? (snapshot.work_order?.wait ?? null) : null
    const wait = waitText === null ? null : (WAITS[waitText] ?? 'other')
    const reason = waitText === null ? '' : t('wait', { wait: wait ?? 'other', text: waitText })
    const action = wait === 'project' ? { label: tProjects('heading'), run: onProjects } : wait === 'order' || wait === 'done' ? { label: tOrders('triggerAsk'), run: onChooseWork } : null

    const short = wait ? t('idleShort') : hold ? t('holdShort', { kind: hold.kind }) : t('state', { state: reported })
    const long = wait ? t('idleLong', { reason }) : hold ? t('holdLong', { kind: hold.kind, seconds: Math.ceil((Date.parse(hold.until) - now) / 1000) }) : short
    const sentence = wait
        ? t('idleSentence', { reason })
        : hold
        ? t('holdSentence', { kind: hold.kind, time: formatDate(hold.until, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })
        : t('now', { state: reported })
    const folds = wait !== null || hold !== undefined
    const pending = asked !== null && asked !== reported && !(asked === 'DRAINING' && reported === 'STOPPED')
    const lines = [sentence, ...(pending ? [t('asked', { state: asked })] : []), ...(waiting > 0 ? [t('noProvider', { count: waiting })] : [])]

    return (
        <>
            <TooltipLabeled label={<span className="flex flex-col gap-0.5">{lines.map(l => <span key={l}>{l}</span>)}</span>}>
                <span role="status" tabIndex={0} data-state-pill={wait ? 'idle' : hold ? 'held' : reported}
                    className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-3 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span aria-hidden className={cn('size-2 rounded-full', wait ? 'bg-amber-500' : hold ? 'bg-red-500' : DOT[reported])} />
                    <span aria-hidden className={cn(folds && '@max-[900px]:hidden')}>{long}</span>
                    {folds && <span aria-hidden className="hidden @max-[900px]:inline">{short}</span>}
                    <span className="sr-only">{lines.join(' ')}</span>
                </span>
            </TooltipLabeled>
            {action?.run && <button type="button" data-pill-action={wait} onClick={action.run} className={ACTION}>{action.label}</button>}
        </>
    )
}
