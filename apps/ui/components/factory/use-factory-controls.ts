'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readFactoryControlsAction } from '@/app/api/_actions/factory.actions'
import type { FactoryControlsView } from '@/app/api/_services/factory-controls.service'
import { useErrorText } from '@/hooks/useErrorText'
import type { SessionContextValue } from '@/supabase/session/SessionProvider'

export const thrown = (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : '' })

export type FactoryControlsState = { view: FactoryControlsView | null; loadError: string | null; reload: () => Promise<void> }

export function useFactoryControls({ workspace, user, role }: Pick<SessionContextValue, 'workspace' | 'user' | 'role'>, reloadOn?: string): FactoryControlsState {
    const errorText = useErrorText()
    const workspaceId = workspace?.id
    const userId = user?.id
    const scope = useMemo(() => ({ workspaceId, userId, role }), [workspaceId, userId, role])
    const [loaded, setLoaded] = useState<(Omit<FactoryControlsState, 'reload'> & { scope: typeof scope }) | null>(null)
    const lifetime = useRef<{ scope: typeof scope; started: number; accepted: number; failed: number } | null>(null)
    useLayoutEffect(() => {
        lifetime.current = { scope, started: 0, accepted: 0, failed: 0 }
        return () => { lifetime.current = null }
    }, [scope])

    const reload = useCallback(async () => {
        const active = lifetime.current
        if (active?.scope !== scope || scope.workspaceId === undefined) return
        const read = ++active.started
        await readFactoryControlsAction().catch(thrown).then((result: Awaited<ReturnType<typeof readFactoryControlsAction>>) => {
            if (lifetime.current !== active || read < active.accepted) return

            if (result.ok) {
                active.accepted = read
                setLoaded({ scope, view: result.controls, loadError: null })
                return
            }
            const denied = result.code === 'notAuthenticated' || result.code === 'notAuthorized' || result.code === 'notMember' || result.code === 'factoryOwnerOnly'
            if (denied) active.accepted = read
            else if (read < active.failed) return
            active.failed = Math.max(active.failed, read)
            const loadError = errorText(result)
            setLoaded(previous => ({ scope, view: !denied && previous?.scope === scope ? previous.view : null, loadError }))
        })
    }, [errorText, scope])
    useEffect(() => { void reload() }, [reload, reloadOn])
    const current = loaded?.scope === scope ? loaded : null
    return { view: current?.view ?? null, loadError: current?.loadError ?? null, reload }
}
