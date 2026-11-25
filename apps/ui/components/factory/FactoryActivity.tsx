'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { FactorySnapshot } from '@moldwright/contracts'
import { formatDate } from '@moldwright/i18n/format'
import { factoryActivity } from './factory-activity'
import type { FactoryControlsState } from './use-factory-controls'

export function FactoryActivity({ controls, snapshot, now, onSelect }: {
    controls: FactoryControlsState
    snapshot: FactorySnapshot | null
    now: number
    onSelect: (issue: number) => void
}) {
    const t = useTranslations('factory.feed')
    const controlsText = useTranslations('factory.controls')
    const locale = useLocale()
    const { repo, status, rows, jobs } = factoryActivity(controls.loadError ? null : controls.view, snapshot, now)
    return (
        <section aria-label={t('title')} className="flex flex-col gap-2 text-sm">
            <h2 className="font-medium">{t('title')}</h2>
            {repo && <p className="break-all text-xs text-muted-foreground">{repo}</p>}
            <p className="text-xs text-muted-foreground">{t('scope')}</p>
            {status !== 'fresh' && <p role="status" className="text-xs text-muted-foreground">{t(status)}</p>}
            {status === 'fresh' && rows.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
            <ol className="max-h-72 divide-y divide-border/60 overflow-y-auto">
                {rows.map(row => (
                    <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                        <time dateTime={row.at} className="text-xs tabular-nums text-muted-foreground">
                            {formatDate(row.at, locale, { dateStyle: 'short', timeStyle: 'medium' })}
                        </time>
                        <span>{row.kind === 'applied'
                            ? t('applied', { state: controlsText('state', { state: row.detail ?? '' }) })
                            : row.kind === 'job' ? t('job', { state: row.detail?.replaceAll('_', ' ') ?? '' }) : t(row.kind, { detail: row.detail ?? '' })}</span>
                        {row.issue !== undefined && (jobs.has(row.issue)
                            ? <button type="button" className="rounded px-1 font-medium underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(row.issue!)}>#{row.issue}</button>
                            : <span className="font-medium">#{row.issue}</span>)}
                    </li>
                ))}
            </ol>
        </section>
    )
}
