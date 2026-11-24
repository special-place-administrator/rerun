import type { InValue, Transaction } from '@libsql/client'
import { getAgent } from '../agents/registry.js'
import { raw } from '../db/client.js'
import { HttpError } from '../lib/errors.js'
import { ulid } from '../lib/ids.js'
import { logger } from '../lib/logger.js'
import { agentAddress, FACTORY_SERVICE, isConcrete, isFactoryThread, parseAddress } from './address.js'
import { BUS_VERSION, envelopeSha, isActionable, postInputSchema, type PostInput } from './envelope.js'
import { secretLabels } from './secrets.js'
import type { BusSender } from './sender.js'

export const BUS_LIMITS = {
    openActionablePerPair: 2,
    corrDepth: 6,
    ackWithinS: 600,
    actionableTtlS: 7 * 86_400,
    passiveTtlS: 86_400,
}

export type BusLimits = typeof BUS_LIMITS

export const SENDING_NEEDS_CONFIRM = 'sending needs operator confirm (rerun agent everos-allow / confirm): until then, write to the owner or answer the agent that asked you'

export type DeliveryState = 'posted' | 'claimed' | 'read' | 'acked' | 'done' | 'expired' | 'dead'

const NEXT: Record<DeliveryState, readonly DeliveryState[]> = {
    posted: ['claimed', 'read', 'expired', 'dead'],
    claimed: ['read', 'posted', 'expired', 'dead'],
    read: ['acked', 'done', 'expired', 'dead'],
    acked: ['done', 'expired', 'dead'],
    done: [],
    expired: [],
    dead: [],
}

const OPEN_STATES = "('posted', 'claimed', 'read', 'acked')"

export type Posted = { id: string; seq: number; thread: string; duplicate: boolean }

const refuse = (status: number, code: string, message: string) => new HttpError(status, message, code)

async function recordEvent(client: Pick<Transaction, 'execute'>, kind: string, actor: string, fields: { msgId?: string; recipient?: string; detail?: string } = {}): Promise<void> {
    const now = Date.now()
    await client.execute({
        sql: 'INSERT INTO bus_events (ts, ts_ms, kind, msg_id, actor, recipient, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [new Date(now).toISOString(), now, kind, fields.msgId ?? null, actor, fields.recipient ?? null, fields.detail ?? null],
    })
}

async function refusePost(sender: BusSender, error: HttpError): Promise<never> {
    logger.info({ sender: sender.address, code: error.code }, 'bus post refused')
    await inTransaction(tx => recordEvent(tx, 'refuse', sender.address, { detail: `${error.code}: ${error.message}` })).catch(() => {})
    throw error
}

function parseInput(input: unknown): PostInput {
    const parsed = postInputSchema.safeParse(input)
    if (parsed.success) return parsed.data
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || (issue.code === 'unrecognized_keys' ? issue.keys.join(',') : 'input')))]
    throw refuse(400, 'bus_invalid', `invalid message fields: ${fields.join(', ')}`)
}

let writeQueue: Promise<unknown> = Promise.resolve()

function inTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const result = writeQueue.then(() => runTransaction(work))
    writeQueue = result.catch(() => {})
    return result
}

async function runTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await raw().transaction('write')
    try {
        const result = await work(tx)
        await tx.commit()
        return result
    } catch (err) {
        await tx.rollback().catch(() => {})
        throw err
    } finally {
        tx.close()
    }
}

async function one(tx: Pick<Transaction, 'execute'>, sql: string, args: InValue[]): Promise<Record<string, unknown> | null> {
    const rs = await tx.execute({ sql, args })
    return (rs.rows[0] as unknown as Record<string, unknown> | undefined) ?? null
}

async function existing(tx: Pick<Transaction, 'execute'>, sender: string, idemKey: string): Promise<Posted | null> {
    const row = await one(tx, 'SELECT id, seq, thread FROM bus_messages WHERE sender = ? AND idem_key = ?', [sender, idemKey])
    return row ? { id: String(row.id), seq: Number(row.seq), thread: String(row.thread), duplicate: true } : null
}

async function seenBy(tx: Pick<Transaction, 'execute'>, msgId: string, address: string): Promise<Record<string, unknown> | null> {
    return one(
        tx,
        'SELECT m.seq, m.sender, m.thread, m.corr, m.depth, EXISTS (SELECT 1 FROM bus_deliveries d WHERE d.seq = m.seq AND d.recipient = ?) AS received FROM bus_messages m WHERE m.id = ?',
        [address, msgId],
    ).then(row => (row && (row.sender === address || Number(row.received) === 1) ? row : null))
}

async function isParticipant(tx: Pick<Transaction, 'execute'>, thread: string, address: string): Promise<boolean> {
    const row = await one(
        tx,
        'SELECT 1 AS ok FROM bus_messages m WHERE m.thread = ? AND (m.sender = ? OR EXISTS (SELECT 1 FROM bus_deliveries d WHERE d.seq = m.seq AND d.recipient = ?)) LIMIT 1',
        [thread, address, address],
    )
    return row !== null
}

async function isBoundGhost(tx: Pick<Transaction, 'execute'>, thread: string, address: string): Promise<boolean> {
    const row = await one(
        tx,
        'SELECT 1 AS ok FROM bus_messages m JOIN bus_deliveries d ON d.seq = m.seq WHERE m.thread = ? AND m.sender = ? AND d.recipient = ? LIMIT 1',
        [thread, FACTORY_SERVICE, address],
    )
    return row !== null
}

async function openRequests(tx: Pick<Transaction, 'execute'>, sender: string, recipient: string): Promise<number> {
    const address = parseAddress(recipient)
    const base = address?.kind === 'agent' ? agentAddress(address.id) : null
    const sql = `SELECT COUNT(*) AS n FROM bus_deliveries WHERE sender = ? AND actionable = 1 AND state IN ${OPEN_STATES} AND `
    const row = base ? await one(tx, `${sql}(recipient = ? OR recipient LIKE ?)`, [sender, base, `${base}#%`]) : await one(tx, `${sql}recipient = ?`, [sender, recipient])
    return Number(row?.n ?? 0)
}

async function recipientsOf(input: PostInput, sender: BusSender, actionable: boolean): Promise<string[]> {
    const recipients = [...new Set(input.to)]
    for (const text of recipients) {
        const address = parseAddress(text)
        if (!address) throw refuse(400, 'bus_address', 'a recipient is not a bus address')
        if (!isConcrete(address)) throw refuse(400, 'bus_address', 'a station, role or group address must be resolved to agents before posting')
        if (text === sender.address) throw refuse(400, 'bus_address', 'a message cannot be sent to its own sender')
        if (address.kind !== 'agent') continue
        const agent = await getAgent(address.id).catch(() => null)
        if (!agent || agent.config.ephemeral) throw refuse(404, 'bus_address', 'no agent has this bus address')
        if (!agent.config.enabled && actionable && sender.untrusted) throw refuse(403, 'bus_disabled', 'the recipient is switched off: untrusted requests to it are refused')
    }
    return recipients
}

export async function postMessage(sender: BusSender, input: unknown, limits: BusLimits = BUS_LIMITS): Promise<Posted> {
    try {
        return await post(sender, input, limits)
    } catch (err) {
        if (err instanceof HttpError && err.code?.startsWith('bus_')) return refusePost(sender, err)
        logger.warn({ sender: sender.address, err: err instanceof Error ? err.name : 'error' }, 'bus post failed')
        throw refuse(500, 'bus_store', 'the message bus could not store the message')
    }
}

async function post(sender: BusSender, input: unknown, limits: BusLimits): Promise<Posted> {
    const own = parseAddress(sender.address)
    if (!own || !isConcrete(own)) throw refuse(403, 'bus_identity', 'the sender has no bus address')
    const message = parseInput(input)
    const labels = secretLabels([message.body, message.idem_key, message.topic ?? '', ...message.to, ...(message.refs ?? [])], sender.secrets)
    if (labels.length > 0) throw refuse(403, 'bus_secret', `refused: the message carries a secret (${labels.join(', ')})`)
    const actionable = isActionable(message.type, message.verdict)
    const recipients = await recipientsOf(message, sender, actionable)

    return inTransaction(async tx => {
        const repeat = await existing(tx, sender.address, message.idem_key)
        if (repeat) return repeat

        const now = Date.now()
        const id = `m_${ulid(now)}`
        let thread = message.thread
        let corr = id
        let depth = 0
        let parent: Record<string, unknown> | null = null
        if (message.re) {
            parent = await seenBy(tx, message.re, sender.address)
            if (!parent) throw refuse(404, 'bus_re', 'the message replied to was not found')
            if (thread && thread !== parent.thread) throw refuse(400, 'bus_thread', 'a reply stays on the thread of the message it answers')
            thread = String(parent.thread)
            corr = String(parent.corr)
            depth = Number(parent.depth) + 1
            if (depth > limits.corrDepth) throw refuse(429, 'bus_depth', `refused: this exchange is over ${limits.corrDepth} hops deep, escalate instead`)
        }
        thread ??= `th_${ulid(now)}`

        const threadExists = (await one(tx, 'SELECT 1 AS ok FROM bus_messages WHERE thread = ? LIMIT 1', [thread])) !== null
        if (isFactoryThread(thread) && sender.address !== FACTORY_SERVICE) {
            const bound = threadExists && (await isBoundGhost(tx, thread, sender.address))
            if (!bound || recipients.some(to => to !== FACTORY_SERVICE)) throw refuse(403, 'bus_thread', 'a factory thread is written only by the factory and the agent it sent the job to')
        } else if (threadExists && !(await isParticipant(tx, thread, sender.address))) {
            throw refuse(403, 'bus_thread', 'the sender is not part of this thread')
        }

        if (sender.pending) {
            const answersAsker = parent !== null && recipients.length === 1 && recipients[0] === parent.sender && Number(parent.received) === 1
            if (!answersAsker && recipients.some(to => !to.startsWith('user:'))) throw refuse(403, 'bus_pending', SENDING_NEEDS_CONFIRM)
        }

        if (actionable) {
            const perTarget = new Map<string, number>()
            for (const recipient of recipients) {
                const address = parseAddress(recipient)
                const target = address?.kind === 'agent' ? agentAddress(address.id) : recipient
                perTarget.set(target, (perTarget.get(target) ?? 0) + 1)
            }
            for (const [target, count] of perTarget) {
                if ((await openRequests(tx, sender.address, target)) + count > limits.openActionablePerPair) throw refuse(429, 'bus_pair_cap', `refused: ${limits.openActionablePerPair} requests to ${target} are still open, wait for an answer`)
            }
        }

        const ts = new Date(now).toISOString()
        const deadlineMs = actionable ? now + (message.ack_within_s ?? limits.ackWithinS) * 1000 : null
        const expiresMs = now + (message.ttl_s ?? (actionable ? limits.actionableTtlS : limits.passiveTtlS)) * 1000
        const untrusted = sender.untrusted || sender.pending
        const refs = message.refs ?? []
        const prio = message.prio ?? 2
        const sha256 = envelopeSha({
            v: BUS_VERSION,
            id,
            from: sender.address,
            to: recipients,
            type: message.type,
            verdict: message.verdict,
            thread,
            topic: message.topic,
            re: message.re,
            corr,
            run: sender.runId,
            prio,
            deadline_at: deadlineMs === null ? undefined : new Date(deadlineMs).toISOString(),
            expires_at: new Date(expiresMs).toISOString(),
            body: message.body,
            refs,
            untrusted,
        })

        const inserted = await tx.execute({
            sql: `INSERT INTO bus_messages (id, v, ts, ts_ms, sender, sender_run, recipients, type, verdict, thread, topic, re, corr, depth, prio, deadline_ms, expires_ms, idem_key, body, refs, untrusted, sha256)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [id, BUS_VERSION, ts, now, sender.address, sender.runId ?? null, JSON.stringify(recipients), message.type, message.verdict ?? null, thread, message.topic ?? null, message.re ?? null, corr, depth, prio, deadlineMs, expiresMs, message.idem_key, message.body, JSON.stringify(refs), untrusted ? 1 : 0, sha256],
        })
        const seq = Number(inserted.lastInsertRowid)
        for (const recipient of recipients) {
            await tx.execute({
                sql: 'INSERT INTO bus_deliveries (seq, recipient, sender, state, actionable, next_ms) VALUES (?, ?, ?, ?, ?, ?)',
                args: [seq, recipient, sender.address, 'posted', actionable ? 1 : 0, actionable ? now : null],
            })
        }
        await recordEvent(tx, 'post', sender.address, { msgId: id, detail: `${message.type} to ${recipients.join(',')}` })
        return { id, seq, thread, duplicate: false }
    })
}

export type Moved = { state: DeliveryState; changed: boolean }

const STAMP: Partial<Record<DeliveryState, string>> = { read: 'read_ms', acked: 'acked_ms', done: 'done_ms' }

export async function moveDelivery(msgId: string, recipient: string, to: DeliveryState, actor: string): Promise<Moved> {
    return inTransaction(async tx => {
        const row = await one(tx, 'SELECT d.seq, d.state, d.actionable FROM bus_deliveries d JOIN bus_messages m ON m.seq = d.seq WHERE m.id = ? AND d.recipient = ?', [msgId, recipient])
        if (!row) throw refuse(404, 'bus_not_found', 'message not found')
        const from = String(row.state) as DeliveryState
        if (from === to) return { state: from, changed: false }
        if (!NEXT[from].includes(to)) throw refuse(409, 'bus_state', `a ${from} message cannot become ${to}`)
        const steps: DeliveryState[] = to === 'read' && Number(row.actionable) === 0 ? ['read', 'done'] : [to]
        const now = Date.now()
        const stamps = steps.map(step => STAMP[step]).filter((column): column is string => !!column)
        const state = steps.at(-1)!
        await tx.execute({
            sql: `UPDATE bus_deliveries SET state = ?${stamps.map(column => `, ${column} = ?`).join('')} WHERE seq = ? AND recipient = ? AND state = ?`,
            args: [state, ...stamps.map(() => now), Number(row.seq), recipient, from],
        })
        for (const step of steps) await recordEvent(tx, step === 'acked' ? 'ack' : step, actor, { msgId, recipient })
        return { state, changed: true }
    })
}

export const ackMessage = (receiver: BusSender, msgId: string): Promise<Moved> => moveDelivery(msgId, receiver.address, 'acked', receiver.address)

export const doneMessage = (receiver: BusSender, msgId: string): Promise<Moved> => moveDelivery(msgId, receiver.address, 'done', receiver.address)
