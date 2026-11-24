import type { AxisPoint, ContainerCellRect, Tile } from '@moldwright/ui/iso-grid'

import { centreOf, podSpots, toWorld, type P } from './factory-rest'
import type { PodView } from './factory-scene'

export function floorFrame({ stage, rightInset, topSpace, bottomSpace, overhead, side }: {
    stage: { width: number; height: number }
    rightInset: number
    topSpace: number
    bottomSpace: number
    overhead: number
    side: number
}): { width: number; height: number; shiftX: number; shiftY: number } {
    return {
        width: Math.max(1, stage.width - rightInset - 2 * side),
        height: Math.max(1, stage.height - overhead - topSpace - bottomSpace),
        shiftX: -rightInset / 2,
        shiftY: (overhead + topSpace - bottomSpace) / 2,
    }
}

export function botCentre({ tiles, pods, routes, floor }: { tiles: Tile[]; pods: PodView[]; routes: Map<string, AxisPoint[]>; floor: ContainerCellRect[] }): P {
    const byId = new Map(tiles.map(t => [t.id, t]))
    const bots = [...tiles.filter(t => t.style?.buddy).map(t => toWorld(centreOf(t))), ...podSpots(pods, byId, routes).map(s => s.at)]
    if (bots.length > 0) return { x: bots.reduce((a, b) => a + b.x, 0) / bots.length, y: bots.reduce((a, b) => a + b.y, 0) / bots.length }
    const corners = floor.flatMap(c => [
        { u: c.col_start, v: c.row_start }, { u: c.col_end + 1, v: c.row_start }, { u: c.col_start, v: c.row_end + 1 }, { u: c.col_end + 1, v: c.row_end + 1 },
    ].map(toWorld))
    if (corners.length === 0) return { x: 0, y: 0 }
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y)
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}
