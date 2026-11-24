'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Ellipsis } from 'lucide-react'
import { toast } from 'sonner'
import { FACTORY_CONTROL_DEFAULT, type FactoryControlState, type FactorySnapshot } from '@moldwright/contracts'
import { setFactoryStateAction } from '@/app/api/_actions/factory.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipDisabledReason, TooltipLabeled } from '@/components/ui/tooltip'
import { useErrorText } from '@/hooks/useErrorText'
import { thrown, type FactoryControlsState } from './use-factory-controls'

const SEGMENTS: { state: FactoryControlState; key: 'start' | 'pause' | 'stop' }[] = [
    { state: 'RUNNING', key: 'start' },
    { state: 'PAUSED', key: 'pause' },
    { state: 'DRAINING', key: 'stop' },
]

export function FactoryRunControl({ snapshot, controls }: { snapshot: FactorySnapshot; controls: FactoryControlsState }) {
    const t = useTranslations('factory.controls')
    const errorText = useErrorText()
    const { view, loadError, reload } = controls
    const [busy, setBusy] = useState<FactoryControlState | null>(null)
    const [confirming, setConfirming] = useState(false)
    const hardStopRef = useRef<HTMLButtonElement>(null)
    const moreRef = useRef<HTMLButtonElement>(null)

    const reported = snapshot.control?.state ?? FACTORY_CONTROL_DEFAULT
    const owner = view?.isOwner === true

    const send = async (state: FactoryControlState) => {
        setBusy(state)
        const res = await setFactoryStateAction(state).catch(thrown)
        if (!res.ok) toast.error(errorText(res))
        else await reload()
        setBusy(null)
    }
    const closeConfirm = (keep: boolean) => {
        if (keep) return
        setConfirming(false)
        requestAnimationFrame(() => (hardStopRef.current?.offsetParent ? hardStopRef.current : moreRef.current)?.focus())
    }

    if (view === null && loadError === null) return <div data-run-control className="flex shrink-0 items-center"><Skeleton className="h-6 w-40 rounded-full" aria-hidden /></div>

    const retry = loadError !== null && (
        <TooltipLabeled label={t('loadFailed')}>
            <Button type="button" size="xs" variant="outline" data-run-retry onClick={() => void reload()}>{t('retry')}</Button>
        </TooltipLabeled>
    )
    if (view === null) return <div data-run-control className="flex shrink-0 items-center">{retry}</div>

    const segments = (
        <ButtonGroup aria-label={t('groupLabel')} aria-busy={busy !== null} className="rounded-lg border border-border/60">
            {SEGMENTS.map(b => (
                <Button key={b.state} type="button" size="xs" variant={reported === b.state ? 'default' : 'ghost'}
                    data-state-button={b.state} aria-pressed={reported === b.state} disabled={!owner || busy !== null}
                    onClick={() => void send(b.state)}>
                    {t(b.key)}
                </Button>
            ))}
        </ButtonGroup>
    )

    return (
        <div data-run-control className="flex shrink-0 items-center gap-2">
            {owner ? segments : <TooltipDisabledReason reason={t('readOnly')}>{segments}</TooltipDisabledReason>}
            {owner && (
                <>
                    <Button ref={hardStopRef} type="button" size="xs" variant="ghost" data-state-button="STOPPED" disabled={busy !== null}
                        className="text-destructive @max-[900px]:hidden" onClick={() => setConfirming(true)}>
                        {t('hardStop')}
                    </Button>
                    <DropdownMenu>
                        <TooltipLabeled label={t('moreControls')}>
                            <DropdownMenuTrigger asChild>
                                <Button ref={moreRef} type="button" size="icon-xs" variant="ghost" aria-label={t('moreControls')} data-more-controls disabled={busy !== null}
                                    className="hidden @max-[900px]:inline-flex">
                                    <Ellipsis aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipLabeled>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>{t('hardStop')}</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
            {retry}
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
