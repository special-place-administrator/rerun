'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FACTORY_CONTROL_DEFAULT, type FactoryControlState, type FactorySnapshot } from '@moldwright/contracts'
import { Badge, type BadgeTone } from '@moldwright/ui/primitives'
import { setFactoryStateAction } from '@/app/api/_actions/factory.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useErrorText } from '@/hooks/useErrorText'
import { cn } from '@/lib/utils'
import { thrown, type FactoryControlsState } from './use-factory-controls'

const NO_PROVIDER = 'no enabled provider'
const BUTTONS: { state: FactoryControlState; key: 'start' | 'pause' | 'stop' | 'hardStop' }[] = [
    { state: 'RUNNING', key: 'start' },
    { state: 'PAUSED', key: 'pause' },
    { state: 'DRAINING', key: 'stop' },
    { state: 'STOPPED', key: 'hardStop' },
]
const TONE: Record<FactoryControlState, BadgeTone> = { RUNNING: 'green', PAUSED: 'orange', DRAINING: 'orange', STOPPED: 'red' }

export function FactoryRunControl({ snapshot, controls }: { snapshot: FactorySnapshot; controls: FactoryControlsState }) {
    const t = useTranslations('factory.controls')
    const errorText = useErrorText()
    const { view, loadError, reload } = controls
    const [busy, setBusy] = useState<FactoryControlState | null>(null)
    const [error, setError] = useState('')
    const [confirming, setConfirming] = useState(false)
    const hardStopRef = useRef<HTMLButtonElement>(null)

    const reported = snapshot.control?.state ?? FACTORY_CONTROL_DEFAULT
    const asked = view?.state ?? null
    const settled = asked === null || asked === reported || (asked === 'DRAINING' && reported === 'STOPPED')
    const waiting = snapshot.jobs.filter(j => j.reason === NO_PROVIDER).length

    const send = async (state: FactoryControlState) => {
        setBusy(state)
        setError('')
        const res = await setFactoryStateAction(state).catch(thrown)
        if (!res.ok) setError(errorText(res))
        else await reload()
        setBusy(null)
    }
    const closeConfirm = (keep: boolean) => { if (!keep) { setConfirming(false); requestAnimationFrame(() => hardStopRef.current?.focus()) } }

    return (
        <div data-run-control className="flex min-w-0 flex-col items-center gap-1">
            {view?.isOwner ? (
                <div role="group" aria-label={t('groupLabel')} aria-busy={busy !== null} className="flex flex-wrap items-center justify-center gap-1">
                    {BUTTONS.map(b => (
                        <Button key={b.state} ref={b.state === 'STOPPED' ? hardStopRef : undefined} type="button" size="xs"
                            variant={b.state === 'STOPPED' ? 'outline' : reported === b.state ? 'default' : 'outline'}
                            data-state-button={b.state} aria-pressed={reported === b.state} disabled={busy !== null}
                            className={cn('rounded-full', b.state === 'STOPPED' && 'text-destructive')}
                            onClick={() => (b.state === 'STOPPED' ? setConfirming(true) : void send(b.state))}>
                            {t(b.key)}
                        </Button>
                    ))}
                </div>
            ) : view === null && loadError === null ? (
                <Skeleton className="h-6 w-40 rounded-full" aria-hidden />
            ) : (
                <Badge size="xs" tone={TONE[reported]} glow={false} data-run-state={reported}>{t('state', { state: reported })}</Badge>
            )}
            <div role="status" aria-live="polite" className="flex max-w-[min(28rem,calc(100vw-2rem))] flex-col items-center text-center text-xs text-muted-foreground">
                <span data-run-now>{t('now', { state: reported })}</span>
                {!settled && asked !== null && busy === null && <span data-run-asked>{t('asked', { state: asked })}</span>}
                {view && !view.isOwner && <span>{t('readOnly')}</span>}
                {waiting > 0 && <span data-no-provider>{t('noProvider', { count: waiting })}</span>}
                {error && <span data-run-error className="text-destructive">{error}</span>}
                {loadError && (
                    <span className="flex items-center gap-2">
                        {t('loadFailed')}
                        <Button type="button" size="xs" variant="outline" onClick={() => void reload()}>{t('retry')}</Button>
                    </span>
                )}
            </div>
            <ConfirmDialog
                open={confirming}
                onOpenChange={closeConfirm}
                title={t('confirmHardStopTitle')}
                description={t('confirmHardStopBody')}
                confirmLabel={t('confirmHardStop')}
                confirmVariant="destructive"
                onConfirm={() => { closeConfirm(false); void send('STOPPED') }}
            />
        </div>
    )
}
