'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readFactoryControlsAction } from '@/app/api/_actions/factory.actions'
import type { FactoryControlsView } from '@/app/api/_services/factory-controls.service'
import { useErrorText } from '@/hooks/useErrorText'

export const thrown = (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : '' })

export type FactoryControlsState = { view: FactoryControlsView | null; loadError: string | null; reload: () => Promise<void> }

export function useFactoryControls(reloadOn?: string): FactoryControlsState {
    const errorText = useErrorText()
    const [view, setView] = useState<FactoryControlsView | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const alive = useRef(true)
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    const apply = useCallback((res: Awaited<ReturnType<typeof readFactoryControlsAction>> | ReturnType<typeof thrown>) => {
        if (!alive.current) return
        if (!res.ok) { setLoadError(errorText(res)); return }
        setLoadError(null)
        setView(res.controls)
    }, [errorText])
    const reload = useCallback(() => readFactoryControlsAction().catch(thrown).then(apply), [apply])
    useEffect(() => { readFactoryControlsAction().catch(thrown).then(apply) }, [apply, reloadOn])
    return { view, loadError, reload }
}
