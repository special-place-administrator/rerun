import { describe, expect, it } from 'vitest'
import type { Tile } from '@moldwright/ui/iso-grid'
import { botCentre, floorFrame } from './factory-camera'
import { toWorld } from './factory-rest'

const base = { stage: { width: 1400, height: 900 }, rightInset: 380, topSpace: 0, bottomSpace: 110, overhead: 120, side: 40 }

describe('floorFrame', () => {
    it('with no top bar gives the numbers the camera used before', () => {
        expect(floorFrame(base)).toEqual({ width: 940, height: 670, shiftX: -190, shiftY: 5 })
    })

    it('a top bar takes its height from the fitted floor and moves the centre down by half of it', () => {
        expect(floorFrame({ ...base, topSpace: 70 })).toEqual({ width: 940, height: 600, shiftX: -190, shiftY: 40 })
    })

    it('never gives less than 1', () => {
        const f = floorFrame({ ...base, stage: { width: 100, height: 100 }, topSpace: 500 })
        expect(f.width).toBe(1)
        expect(f.height).toBe(1)
    })
})

describe('botCentre', () => {
    const buddy = (id: string, col: number, row: number): Tile => ({ id, position: { col, row }, span: 2, style: { color: '', buddy: true } })
    const station = (id: string, col: number, row: number): Tile => ({ id, position: { col, row }, span: 2, style: { color: '' } })
    const floor = [{ col_start: 0, row_start: 0, col_end: 39, row_end: 39 }]

    it('is the mean of the bots, not of the tiles they share the floor with, and the floor centre when there are no bots', () => {
        const a = toWorld({ u: 3, v: 3 }), b = toWorld({ u: 9, v: 5 })
        const tiles = [buddy('ann', 2, 2), buddy('bob', 8, 4), station('tank', 30, 36), station('desk', 34, 2)]
        expect(botCentre({ tiles, pods: [], routes: new Map(), floor })).toEqual({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        expect(botCentre({ tiles: tiles.filter(t => !t.style.buddy), pods: [], routes: new Map(), floor })).toEqual(toWorld({ u: 20, v: 20 }))
    })
})
