'use client'

import { useState, type SyntheticEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@moldwright/ui/primitives'
import { setFactoryProviderAction } from '@/app/api/_actions/factory.actions'
import { thrown, useFactoryControls } from '@/components/factory/use-factory-controls'
import { Switch } from '@/components/ui/switch'
import { useErrorText } from '@/hooks/useErrorText'
import type { BoxConnection } from '@/lib/engine/types'
import { useSession } from '@/supabase/session/SessionProvider'

export type FactoryProviders = { off: ReadonlySet<string>; isOwner: boolean; busy: string | null; error: string; toggle: (connectionId: string, enabled: boolean) => void }

export function useFactoryProviders(): FactoryProviders | null {
    const session = useSession()
    const { view, reload } = useFactoryControls(session)
    const errorText = useErrorText()
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState('')
    if (!view?.activeRepo) return null
    const toggle = async (connectionId: string, enabled: boolean) => {
        setBusy(connectionId)
        setError('')
        const res = await setFactoryProviderAction(connectionId, enabled).catch(thrown)
        if (!res.ok) setError(errorText(res))
        else await reload()
        setBusy(null)
    }
    return { off: new Set(view.providersOff), isOwner: view.isOwner, busy, error, toggle: (id, enabled) => void toggle(id, enabled) }
}

const keepInRow = (e: SyntheticEvent) => e.stopPropagation()

export function FactoryProviderSwitch({ connection, factory }: { connection: BoxConnection; factory: FactoryProviders }) {
    const t = useTranslations('factory.providers')
    const on = !factory.off.has(connection.id)
    if (!factory.isOwner) return on ? null : <Badge size="xs" tone="orange" glow={false} data-factory-off={connection.id}>{t('offBadge')}</Badge>
    return (
        <span role="presentation" onClick={keepInRow} onKeyDown={keepInRow} className="flex items-center gap-1.5">
            <span className="hidden text-[11px] text-muted-foreground sm:inline" aria-hidden>{t('label')}</span>
            <Switch checked={on} disabled={factory.busy !== null} aria-busy={factory.busy === connection.id} data-factory-switch={connection.id}
                aria-label={t('toggle', { name: connection.name })} onCheckedChange={checked => factory.toggle(connection.id, checked)} />
        </span>
    )
}

export function FactoryProvidersNote({ factory }: { factory: FactoryProviders }) {
    const t = useTranslations('factory.providers')
    return (
        <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
            <p>{factory.isOwner ? t('note') : t('noteReadOnly')}</p>
            {factory.error && <p className="text-destructive">{factory.error}</p>}
        </div>
    )
}
