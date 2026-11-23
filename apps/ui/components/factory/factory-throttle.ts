import { FACTORY_POOL_DEFAULT, FACTORY_SEATS_DEFAULT, factoryGhostCeiling, factoryStationNames, type FactorySnapshot } from '@moldwright/contracts'
import type { FactoryControlsView } from '@/app/api/_services/factory-controls.service'

export type StationThrottle = { name: string; seats: number; running: number }
export type FactoryThrottleShown = { pool: number; ceiling: number; running: number; stations: StationThrottle[] }

const outOf = (snapshot: FactorySnapshot, type?: string) =>
    snapshot.pools.filter(p => type === undefined || p.type === type).reduce((n, p) => n + p.coworkers.reduce((m, c) => m + c.out, 0), 0)

export function throttleShown(snapshot: FactorySnapshot, view: FactoryControlsView | null): FactoryThrottleShown {
    const reported = snapshot.throttle
    const ceiling = factoryGhostCeiling(snapshot)
    const pool = Math.min(view?.throttle?.maxGhosts ?? reported?.max_ghosts ?? FACTORY_POOL_DEFAULT, ceiling)
    const stations = factoryStationNames(snapshot).map(name => ({
        name,
        seats: Math.min(view?.throttle?.stations[name] ?? reported?.stations?.[name]?.max ?? FACTORY_SEATS_DEFAULT, pool),
        running: reported?.stations?.[name]?.running ?? outOf(snapshot, name),
    }))
    return { pool, ceiling, running: reported?.ghosts_running ?? outOf(snapshot), stations }
}
