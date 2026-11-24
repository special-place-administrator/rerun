// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { factorySnapshotSchema, type FactorySnapshot } from '@moldwright/contracts'
import type { IsoCamera } from '@moldwright/ui/iso-grid'
import { TooltipProvider } from '@/components/ui/tooltip'
import { flushCamera, readCamera } from '@/lib/camera-storage'
import { FactoryWorld } from './FactoryWorld'
import { sceneFromSnapshot } from './from-snapshot'

const grid = vi.hoisted(() => ({ props: null as null | { camera: IsoCamera | null; className?: string; onCameraChange: (c: IsoCamera) => void }, frames: 0 }))
vi.mock('@moldwright/ui/iso-grid', async importOriginal => ({
    ...(await importOriginal<typeof import('@moldwright/ui/iso-grid')>()),
    IsoGrid: (props: NonNullable<typeof grid.props>) => { grid.props = props; return null },
    useRenderedFrame: () => ({ ref: { current: null }, frame: grid.frames++ % 3 === 0 ? { width: 1600, height: 900 } : { width: 1600, height: 72 } }),
}))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() })

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const SCOPE = 'factory:7:u1'
const live = (ageMs: number): FactorySnapshot => ({
    ...factorySnapshotSchema.parse(JSON.parse(readFileSync(path.join(ROOT, 'packages/contracts/fixtures/factory-snapshot.sample.json'), 'utf8'))),
    madeAt: new Date(Date.now() - ageMs).toISOString(),
})

let host: HTMLDivElement
let root: Root
const render = (props: { rightInset?: number; snapshot?: FactorySnapshot | null }) => act(async () => {
    const snapshot = props.snapshot ?? null
    root.render(createElement(TooltipProvider, null, createElement(FactoryWorld, {
        workspace: '7', cameraScope: SCOPE, rightInset: props.rightInset ?? 0, snapshot,
        ...(snapshot ? { scene: (_: number, now: number) => sceneFromSnapshot(snapshot, now) } : {}),
    })))
})
const camera = () => grid.props!.camera

beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('factory camera', () => {
    it('fits once, ignores panel, poll and stale changes, and restores the saved view after a reload', async () => {
        await render({})
        const fitted = camera()
        expect(fitted).not.toBeNull()

        await render({ rightInset: 648 })
        await render({ rightInset: 648, snapshot: live(0) })
        await render({ rightInset: 0, snapshot: live(5 * 60_000) })
        const staleMark = host.querySelector('[data-stale-age]')
        expect(staleMark).not.toBeNull()
        expect(staleMark!.textContent).toMatch(/^data \d+m old$/)
        expect(host.querySelector('[data-last-beat]')).toBe(staleMark)
        await render({ rightInset: 0, snapshot: live(5 * 3_600_000) })
        expect(host.querySelector('[data-stale-age]')!.textContent).toMatch(/^data \d+h old$/)
        expect(grid.props!.className).toBeUndefined()
        expect(camera()).toBe(fitted)

        await act(async () => grid.props!.onCameraChange({ zoom: 0.42, pan: { x: 12, y: -34 } }))
        flushCamera()
        expect(readCamera(SCOPE)).toEqual({ zoom: 0.42, pan: { x: 12, y: -34 } })

        act(() => root.unmount())
        root = createRoot(host)
        await render({ rightInset: 648, snapshot: live(0) })
        expect(camera()).toMatchObject({ zoom: 0.42, pan: { x: 12, y: -34 } })
        const restored = camera()
        await render({ rightInset: 0, snapshot: live(5 * 60_000) })
        expect(camera()).toBe(restored)
    })
})
