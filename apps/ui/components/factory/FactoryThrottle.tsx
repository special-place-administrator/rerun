'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { FactorySnapshot } from '@moldwright/contracts'
import { setFactoryPoolAction, setFactorySeatsAction } from '@/app/api/_actions/factory.actions'
import { toast } from 'sonner'
import { DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useErrorText } from '@/hooks/useErrorText'
import { throttleShown } from './factory-throttle'
import { thrown, type FactoryControlsState } from './use-factory-controls'

type Saved = { ok: true } | { ok: false; error?: string }

function NumberPick({ id, label, value, max, usage, editable, save, reload, valueText }: {
    id: string; label: string; value: number; max: number; usage: string; editable: boolean
    save: (n: number) => Promise<Saved>; reload: () => Promise<void>; valueText?: (n: number) => string
}) {
    const t = useTranslations('factory.controls')
    const errorText = useErrorText()
    const [pending, setPending] = useState<number | null>(null)
    const [saved, setSaved] = useState<number | null>(null)
    const [error, setError] = useState('')
    const shown = pending ?? value

    const commit = async (n: number) => {
        if (n === value) return
        setPending(n)
        setSaved(null)
        setError('')
        const res = await save(n).catch(thrown)
        if (res.ok) { await reload(); setSaved(n) } else setError(errorText(res))
        setPending(null)
    }

    if (valueText) {
        return (
            <div data-number-pick={id} className="flex shrink-0 items-center">
                {editable ? (
                    <Select value={String(shown)} onValueChange={v => void commit(Number(v))} disabled={pending !== null}>
                        <SelectTrigger id={id} size="sm" aria-label={label} aria-busy={pending !== null} aria-invalid={error !== '' || undefined} title={error || undefined}
                            className="h-7 rounded-full text-xs tabular-nums">
                            <SelectValue>{valueText(shown)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                            {Array.from({ length: max + 1 }, (_, n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                        </SelectContent>
                    </Select>
                ) : (
                    <span data-number-value className="text-xs tabular-nums">{valueText(shown)}</span>
                )}
                <span role="status" aria-live="polite" className="sr-only">
                    {saved !== null && <span data-saved>{t('throttleSaved', { label, value: saved })}</span>}
                    {error && <span data-pick-error>{error}</span>}
                </span>
            </div>
        )
    }

    return (
        <div data-number-pick={id} className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-2">
                <Field orientation="row" label={label} htmlFor={editable ? id : undefined} className="gap-2">
                    {editable ? (
                        <Select value={String(shown)} onValueChange={v => void commit(Number(v))} disabled={pending !== null}>
                            <SelectTrigger id={id} size="sm" aria-busy={pending !== null} className="h-7 min-w-14 rounded-full text-xs tabular-nums">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-64">
                                {Array.from({ length: max + 1 }, (_, n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    ) : (
                        <span data-number-value className="text-xs tabular-nums">{shown}</span>
                    )}
                </Field>
                <span data-usage className="text-xs tabular-nums text-muted-foreground">{usage}</span>
            </div>
            <span role="status" aria-live="polite" className="text-xs">
                {saved !== null && <span data-saved className="text-muted-foreground">{t('throttleSaved', { label, value: saved })}</span>}
                {error && <span data-pick-error className="text-destructive">{error}</span>}
            </span>
        </div>
    )
}

export function FactoryPoolPick({ snapshot, controls }: { snapshot: FactorySnapshot; controls: FactoryControlsState }) {
    const t = useTranslations('factory.controls')
    const { pool, ceiling, running } = throttleShown(snapshot, controls.view)
    return (
        <NumberPick id="factory-pool" label={t('pool')} value={pool} max={ceiling} usage={t('usage', { running, max: pool })}
            editable={controls.view?.isOwner === true} save={setFactoryPoolAction} reload={controls.reload} valueText={count => t('poolValue', { count })} />
    )
}

export function FactoryPoolMenu({ snapshot, controls }: { snapshot: FactorySnapshot; controls: FactoryControlsState }) {
    const t = useTranslations('factory.controls')
    const errorText = useErrorText()
    const { pool, ceiling } = throttleShown(snapshot, controls.view)
    const [pending, setPending] = useState<number | null>(null)
    const shown = pending ?? pool
    const label = t('poolValue', { count: shown })
    if (controls.view?.isOwner !== true) return <DropdownMenuItem disabled>{label}</DropdownMenuItem>

    const commit = async (n: number) => {
        if (n === pool) return
        setPending(n)
        const res = await setFactoryPoolAction(n).catch(thrown)
        if (res.ok) await controls.reload()
        else toast.error(errorText(res))
        setPending(null)
    }
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger data-pool-menu disabled={pending !== null}>{label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                <DropdownMenuRadioGroup value={String(shown)} onValueChange={v => void commit(Number(v))}>
                    {Array.from({ length: ceiling + 1 }, (_, n) => <DropdownMenuRadioItem key={n} value={String(n)}>{n}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    )
}

export function FactorySeatsPick({ snapshot, controls, station }: { snapshot: FactorySnapshot; controls: FactoryControlsState; station: string }) {
    const t = useTranslations('factory.controls')
    const { pool, stations } = throttleShown(snapshot, controls.view)
    const shown = stations.find(s => s.name === station)
    if (!shown) return null
    return (
        <NumberPick id={`factory-seats-${station}`} label={t('seats')} value={shown.seats} max={pool} usage={t('usage', { running: shown.running, max: shown.seats })}
            editable={controls.view?.isOwner === true} save={n => setFactorySeatsAction(station, n)} reload={controls.reload} />
    )
}
