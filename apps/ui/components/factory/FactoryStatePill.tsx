'use client'

import { useLocale, useTranslations } from 'next-intl'
import { FACTORY_CONTROL_DEFAULT, type FactoryControlState, type FactorySnapshot } from '@moldwright/contracts'
import { formatDate } from '@moldwright/i18n/format'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { liveHold } from './from-snapshot'
import type { FactoryControlsState } from './use-factory-controls'

const NO_PROVIDER = 'no enabled provider'
const DOT: Record<FactoryControlState, string> = { RUNNING: 'bg-emerald-500', PAUSED: 'bg-amber-500', DRAINING: 'bg-amber-500', STOPPED: 'bg-red-500' }

export function FactoryStatePill({ snapshot, controls, now }: { snapshot: FactorySnapshot; controls: FactoryControlsState; now: number }) {
    const t = useTranslations('factory.controls')
    const locale = useLocale()
    const reported = snapshot.control?.state ?? FACTORY_CONTROL_DEFAULT
    const asked = controls.view?.state ?? null
    const waiting = snapshot.jobs.filter(j => j.reason === NO_PROVIDER).length
    const hold = liveHold(snapshot, now)

    const short = hold ? t('holdShort', { kind: hold.kind }) : t('state', { state: reported })
    const long = hold ? t('holdLong', { kind: hold.kind, seconds: Math.ceil((Date.parse(hold.until) - now) / 1000) }) : short
    const sentence = hold
        ? t('holdSentence', { kind: hold.kind, time: formatDate(hold.until, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })
        : t('now', { state: reported })
    const pending = asked !== null && asked !== reported && !(asked === 'DRAINING' && reported === 'STOPPED')
    const lines = [sentence, ...(pending ? [t('asked', { state: asked })] : []), ...(waiting > 0 ? [t('noProvider', { count: waiting })] : [])]

    return (
        <TooltipLabeled label={<span className="flex flex-col gap-0.5">{lines.map(l => <span key={l}>{l}</span>)}</span>}>
            <span role="status" tabIndex={0} data-state-pill={hold ? 'held' : reported}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-3 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span aria-hidden className={cn('size-2 rounded-full', hold ? 'bg-red-500' : DOT[reported])} />
                <span aria-hidden className={cn(hold && '@max-[900px]:hidden')}>{long}</span>
                {hold && <span aria-hidden className="hidden @max-[900px]:inline">{short}</span>}
                <span className="sr-only">{lines.join(' ')}</span>
            </span>
        </TooltipLabeled>
    )
}
