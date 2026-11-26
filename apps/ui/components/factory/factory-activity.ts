import type { FactorySnapshot } from '@moldwright/contracts'
import type { FactoryControlsView } from '@/app/api/_services/factory-controls.service'
import { isAnswering } from './factory-loader'

export type ActivityRow = {
    id: string
    at: string
    kind: 'requested' | 'applied' | 'added' | 'cancelled' | 'accepted' | 'current' | 'done' | 'skipped' | 'held' | 'waiting' | 'job'
    issue?: number
    detail?: string | undefined
}

const HOLD_REASONS = new Map([
    ['stopped', 'stopped'], ['paused', 'paused'], ['draining', 'draining'], ['no work', 'noWork'],
])
const ORDER_WAITS = [
    [/^issue #(\d+) is labelled factory-paused$/, 'issuePaused'],
    [/^issue #(\d+) body is not cut-shaped$/, 'issueShape'],
] as const

export function factoryActivity(view: FactoryControlsView | null, snapshot: FactorySnapshot | null, now: number) {
    const rows: ActivityRow[] = []
    const repo = view?.activeRepo ?? null
    const report = repo && snapshot?.repo === repo ? snapshot : null
    const status: 'unavailable' | 'fresh' | 'stale' = !report ? 'unavailable' : isAnswering(report.madeAt, now) ? 'fresh' : 'stale'

    function add(id: string, at: string | null | undefined, kind: ActivityRow['kind'], issue?: number, detail?: string) {
        if (!at || !Number.isFinite(Date.parse(at))) return
        rows.push({ id, at, kind, ...(issue === undefined ? {} : { issue }), detail })
    }

    if (view?.state) add('control-request', view.stateAt, 'requested', undefined, view.state)
    for (const order of view?.orders ?? []) {
        if (order.repo !== repo) continue
        for (const issue of order.issues) {
            add(`added:${order.id}:${issue}`, order.created_at, 'added', issue)
            add(`cancelled:${order.id}:${issue}`, order.cancelled_at, 'cancelled', issue)
            if (order.action?.action === 'skip' && order.action.issue === issue) {
                add(`skip-request:${order.id}:${issue}`, order.action.at, 'requested', issue, 'SKIP')
            }
        }
    }

    if (report) {
        if (report.control) add('control-applied', report.control.at, 'applied', undefined, report.control.state)
        report.holds.forEach((hold, index) => {
            if (Date.parse(hold.until) > Date.parse(report.madeAt)) {
                add(`hold:${index}`, report.madeAt, 'held', undefined, HOLD_REASONS.get(hold.kind))
            }
        })

        const order = report.work_order
        const request = order?.id && view?.orders.find(item => item.id === order.id && item.repo === repo)
        if (order && request && order.repo === repo) {
            for (const issue of request.issues) {
                add(`accepted:${issue}`, order.at, 'accepted', issue)
                if (order.current === issue) add(`current:${issue}`, report.madeAt, 'current', issue)
                if (order.done.includes(issue)) add(`done:${issue}`, report.madeAt, 'done', issue)
                if (order.skipped.includes(issue)) add(`skipped:${issue}`, report.madeAt, 'skipped', issue)
                if (order.halted === issue) add(`halted:${issue}`, report.madeAt, 'held', issue, 'failedJob')
            }
            for (const [pattern, reason] of ORDER_WAITS) {
                const issue = Number(order.wait?.match(pattern)?.[1])
                if (request.issues.includes(issue)) add(`waiting:${issue}`, report.madeAt, 'waiting', issue, reason)
            }
        }

        for (const job of report.jobs) {
            const history = job.history?.length ? job.history : [{ at: job.enteredAt, state: job.state }]
            history.forEach((event, index) => add(`job:${job.issue}:${index}`, event.at, 'job', job.issue, event.state))
        }
    }

    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    return { repo, status, rows: rows.slice(0, 100), jobs: new Set(report?.jobs.map(job => job.issue)) }
}
