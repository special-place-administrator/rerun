'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { FactorySnapshot } from '@moldwright/contracts'
import { clearFactoryQueueAction } from '@/app/api/_actions/factory.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useErrorText } from '@/hooks/useErrorText'
import { thrown, type FactoryControlsState } from './use-factory-controls'

// MW-QUEUE-CLEAR: the owner clears the pending jobs this queue shows. The dispatcher cancels only those
// still unclaimed and reports cleared/kept under the request id; until that report lands the line says so.
export function FactoryClearQueue({ snapshot, controls, issues }: { snapshot: FactorySnapshot; controls: FactoryControlsState; issues: number[] }) {
    const t = useTranslations('factory.controls')
    const errorText = useErrorText()
    const [confirming, setConfirming] = useState(false)
    const [busy, setBusy] = useState(false)
    const [sent, setSent] = useState<string | null>(null)
    const ref = useRef<HTMLButtonElement>(null)

    if (controls.view?.isOwner !== true) return null
    const repo = snapshot.repo
    const report = snapshot.queue_clear?.repo === repo ? snapshot.queue_clear : undefined
    const waiting = sent !== null && report?.id !== sent

    const closeConfirm = (keep: boolean) => {
        if (keep) return
        setConfirming(false)
        requestAnimationFrame(() => ref.current?.focus())
    }
    const clear = async () => {
        if (repo === null) return
        setBusy(true)
        const res = await clearFactoryQueueAction(repo, issues).catch(thrown)
        if (!res.ok) toast.error(errorText(res))
        else {
            setSent(res.id)
            toast.success(t('queueClearSent', { count: res.count }))
            await controls.reload()
        }
        setBusy(false)
    }

    return (
        <div data-clear-queue className="flex items-center justify-between gap-2">
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {waiting ? t('queueClearWaiting') : report ? t('queueClearReport', { cleared: report.cleared.length, kept: report.kept.length }) : null}
            </span>
            <Button ref={ref} type="button" size="xs" variant="ghost" className="text-destructive" data-clear-queue-button
                disabled={repo === null || issues.length === 0 || busy} aria-busy={busy} onClick={() => setConfirming(true)}>
                {t('clearQueue')}
            </Button>
            <ConfirmDialog
                open={confirming}
                onOpenChange={closeConfirm}
                title={t('confirmClearQueueTitle', { count: issues.length })}
                description={t('confirmClearQueueBody')}
                confirmLabel={t('confirmClearQueue')}
                confirmVariant="destructive"
                onConfirm={() => { closeConfirm(false); void clear() }}
            />
        </div>
    )
}
