import { describe, expect, it } from 'vitest'
import type { FactorySnapshot } from '@moldwright/contracts'
import type { FactoryControlsView } from '@/app/api/_services/factory-controls.service'
import { factoryActivity } from './factory-activity'

const at = '2026-11-25T17:20:00.000Z'
const now = Date.parse(at)
const view: FactoryControlsView = {
    isOwner: false, activeRepo: 'o/r', state: null, stateAt: null, providersOff: [], throttle: null, projectLimits: null, orders: [],
}
const snapshot = { repo: 'o/r', madeAt: at, jobs: [], holds: [] } as unknown as FactorySnapshot

describe('factory activity', () => {
    it('distinguishes empty, stale and unavailable dispatcher history', () => {
        expect(factoryActivity(view, snapshot, now)).toMatchObject({ rows: [], status: 'fresh' })
        expect(factoryActivity(view, snapshot, now + 61_000)).toMatchObject({ rows: [], status: 'stale' })
        expect(factoryActivity(view, null, now)).toMatchObject({ rows: [], status: 'unavailable' })
    })

    it('does not treat another project report as the selected project or lose workspace requests', () => {
        const other = { ...snapshot, repo: 'o/old', holds: [{ kind: 'stopped', until: '2026-11-25T17:21:00.000Z' }] }
        expect(factoryActivity({ ...view, state: 'RUNNING', stateAt: at }, other, now)).toMatchObject({
            repo: 'o/r',
            status: 'unavailable',
            rows: [{ kind: 'requested', at, detail: 'RUNNING' }],
        })
    })

    it('uses bounded event fields and omits unrecognized hold reasons', () => {
        const unknown = 'private dispatcher details'
        const report = {
            ...snapshot,
            holds: [{ kind: unknown, until: '2026-11-25T17:21:00.000Z' }],
            control: { state: 'STOPPED', at, by: unknown },
        } as FactorySnapshot
        const activity = factoryActivity(view, report, now)
        expect(activity.rows).toMatchObject([{ kind: 'applied', detail: 'STOPPED' }, { kind: 'held', detail: undefined }])
        expect(JSON.stringify(activity.rows)).not.toContain(unknown)
    })
})
