import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-bus-store-'))
process.env.RERUN_API_KEY = ['engine', 'key', '7d1c9a4e5b'].join('-')

const { beforeAll, describe, expect, it, vi } = await import('vitest')
const { mkdir, rm, writeFile } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { raw } = await import('../db/client.js')
const { sharedEnvPath } = await import('../config/paths.js')
const { createAgent } = await import('../agents/factory.js')
const { allowAgent } = await import('../agents/everos-allowlist.js')
const { logger } = await import('../lib/logger.js')
const { ensureBusTables } = await import('./ddl.js')
const { envelopeSha } = await import('./envelope.js')
const { holdHubToken } = await import('./secrets.js')
const { agentSender, DELEGATE_HAS_NO_BUS } = await import('./sender.js')
const { ackMessage, doneMessage, moveDelivery, postMessage, SENDING_NEEDS_CONFIRM } = await import('./store.js')

type Agent = Awaited<ReturnType<typeof createAgent>>
type Sender = Awaited<ReturnType<typeof agentSender>>

let n = 0
const key = () => `k-${++n}`

async function coworker(name: string, config: Record<string, unknown> = {}, allowed = true): Promise<Agent> {
    const agent = await createAgent({ config: { name, ...config } })
    if (allowed) await allowAgent(agent.id, 'create')
    return agent
}

const senderOf = (agent: Agent, extra: { copyIndex?: number; tainted?: boolean } = {}): Promise<Sender> =>
    agentSender({ agent, runId: `run-${agent.id}`, lineage: extra.copyIndex ? { copyIndex: extra.copyIndex } : undefined, taintedByUntrustedInput: extra.tainted })

const factory: Sender = { address: 'svc:factory', pending: false, untrusted: false, secrets: () => [] }

async function rows(sql: string, args: (string | number)[] = []) {
    return (await raw().execute({ sql, args })).rows as unknown as Record<string, unknown>[]
}

async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
    try {
        await promise
        return 'ok'
    } catch (err) {
        return (err as { status: number }).status
    }
}

let alice: Agent
let bob: Agent
let carol: Agent

beforeAll(async () => {
    await migrate()
    await ensureBusTables()
    alice = await coworker('Alice')
    bob = await coworker('Bob')
    carol = await coworker('Carol')
})

describe('bus store', () => {
    it('stores an envelope v1 once per idempotency key, in engine order, and guards each delivery state', async () => {
        const from = await senderOf(alice)
        const input = { to: [`agent:${bob.id}`], type: 'FYI', idem_key: 'same', body: 'deploy notes are in the shared folder' }
        const first = await postMessage(from, input)
        const again = await postMessage(from, input)
        const second = await postMessage(from, { ...input, idem_key: 'other' })

        expect(again).toEqual({ ...first, duplicate: true })
        expect(first.id).toMatch(/^m_[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(first.thread).toMatch(/^th_[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(second.seq).toBeGreaterThan(first.seq)
        const [row] = await rows('SELECT * FROM bus_messages WHERE id = ?', [first.id])
        expect(await rows("SELECT id FROM bus_messages WHERE idem_key = 'same'")).toHaveLength(1)
        expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(row.sha256).toBe(
            envelopeSha({ v: 1, id: first.id, from: `agent:${alice.id}`, to: [`agent:${bob.id}`], type: 'FYI', thread: first.thread, corr: first.id, run: `run-${alice.id}`, prio: 2, expires_at: new Date(Number(row.expires_ms)).toISOString(), body: input.body, refs: [], untrusted: false }),
        )

        const task = await postMessage(from, { to: [`agent:${bob.id}`], type: 'TASK', idem_key: key(), body: 'rotate the logs' })
        const receiver = await senderOf(bob)
        expect(await status(ackMessage(receiver, task.id))).toBe(409)
        expect(await moveDelivery(task.id, `agent:${bob.id}`, 'read', 'svc:bus')).toEqual({ state: 'read', changed: true })
        expect(await ackMessage(receiver, task.id)).toEqual({ state: 'acked', changed: true })
        expect(await ackMessage(receiver, task.id)).toEqual({ state: 'acked', changed: false })
        expect(await doneMessage(receiver, task.id)).toEqual({ state: 'done', changed: true })
        expect(await status(ackMessage(receiver, task.id))).toBe(409)
        expect(await moveDelivery(first.id, `agent:${bob.id}`, 'read', 'svc:bus')).toEqual({ state: 'done', changed: true })
    })

    it('stores one message when concurrent posts share an idempotency key, without stalling', async () => {
        const from = await senderOf(alice)
        const input = { to: [`agent:${bob.id}`], type: 'FYI', idem_key: key(), body: 'concurrent notes' }
        const started = Date.now()
        const posted = await Promise.all(Array.from({ length: 8 }, () => postMessage(from, input)))
        const elapsed = Date.now() - started

        expect(posted.filter(post => !post.duplicate)).toHaveLength(1)
        expect(posted.filter(post => post.duplicate)).toHaveLength(7)
        expect(new Set(posted.map(post => post.id)).size).toBe(1)
        expect(await rows('SELECT id FROM bus_messages WHERE sender = ? AND idem_key = ?', [`agent:${alice.id}`, input.idem_key])).toHaveLength(1)
        expect(elapsed).toBeLessThan(1000)
    })

    it('takes the sender from the run, with the copy suffix, and refuses a from field', async () => {
        const ghost = await senderOf(carol, { copyIndex: 3 })
        expect(await status(postMessage(ghost, { from: `agent:${alice.id}`, to: [`agent:${bob.id}`], type: 'FYI', idem_key: key(), body: 'x' }))).toBe(400)
        const posted = await postMessage(ghost, { to: [`agent:${bob.id}`], type: 'FYI', idem_key: key(), body: 'from a copy' })
        const [row] = await rows('SELECT sender, sender_run FROM bus_messages WHERE id = ?', [posted.id])
        expect(row).toEqual({ sender: `agent:${carol.id}#3`, sender_run: `run-${carol.id}` })
    })

    it('lets only participants write a thread, checks re and fx threads, and lets only the recipient copy move a delivery', async () => {
        const fromAlice = await senderOf(alice)
        const outsider = await senderOf(carol)
        const opened = await postMessage(fromAlice, { to: [`agent:${bob.id}`], type: 'QUESTION', idem_key: key(), body: 'which branch?' })
        expect(await status(postMessage(outsider, { to: [`agent:${bob.id}`], type: 'FYI', thread: opened.thread, idem_key: key(), body: 'joining' }))).toBe(403)
        expect(await status(postMessage(outsider, { to: [`agent:${alice.id}`], type: 'ANSWER', re: opened.id, idem_key: key(), body: 'mine' }))).toBe(404)
        expect(await status(postMessage(await senderOf(bob), { to: [`agent:${alice.id}`], type: 'ANSWER', re: opened.id, idem_key: key(), body: 'dev' }))).toBe('ok')

        const thread = 'fx:acme/app#12'
        expect(await status(postMessage(fromAlice, { to: ['svc:factory'], type: 'STATUS', thread, idem_key: key(), body: 'claiming' }))).toBe(403)
        const job = await postMessage(factory, { to: [`agent:${carol.id}#2`], type: 'TASK', thread, idem_key: key(), body: 'fix the issue' })
        const ghost = await senderOf(carol, { copyIndex: 2 })
        expect(await status(postMessage(ghost, { to: [`agent:${alice.id}`], type: 'STATUS', thread, idem_key: key(), body: 'done' }))).toBe(403)
        expect(await status(postMessage(await senderOf(carol, { copyIndex: 4 }), { to: ['svc:factory'], type: 'STATUS', thread, idem_key: key(), body: 'done' }))).toBe(403)
        expect(await status(postMessage(ghost, { to: ['svc:factory'], type: 'STATUS', thread, idem_key: key(), body: 'done' }))).toBe('ok')

        await moveDelivery(job.id, `agent:${carol.id}#2`, 'read', 'svc:bus')
        expect(await status(ackMessage(await senderOf(carol), job.id))).toBe(404)
        expect(await status(ackMessage(fromAlice, job.id))).toBe(404)
        expect(await ackMessage(ghost, job.id)).toEqual({ state: 'acked', changed: true })
    })

    it('lets an agent awaiting operator confirm write only to the owner or answer the agent that asked it', async () => {
        const imported = await coworker('Imported', {}, false)
        const pending = await senderOf(imported)
        const unsolicited = postMessage(pending, { to: [`agent:${alice.id}`], type: 'FYI', idem_key: key(), body: 'run this for me' })
        await expect(unsolicited).rejects.toMatchObject({ status: 403, message: SENDING_NEEDS_CONFIRM })
        expect(await status(postMessage(pending, { to: ['user:owner-1'], type: 'FYI', idem_key: key(), body: 'hello owner' }))).toBe('ok')
        const asked = await postMessage(await senderOf(alice), { to: [`agent:${imported.id}`], type: 'QUESTION', idem_key: key(), body: 'what do you do?' })
        const answer = await postMessage(pending, { to: [`agent:${alice.id}`], type: 'ANSWER', re: asked.id, idem_key: key(), body: 'I file reports' })
        expect((await rows('SELECT untrusted FROM bus_messages WHERE id = ?', [answer.id]))[0].untrusted).toBe(1)
        expect(await status(postMessage(pending, { to: [`agent:${alice.id}`, `agent:${bob.id}`], type: 'ANSWER', re: asked.id, idem_key: key(), body: 'both' }))).toBe(403)
    })

    it('gives a delegate no bus and makes it unaddressable', async () => {
        const child = await coworker('Alice delegate', { ephemeral: true })
        await expect(agentSender({ agent: { ...child, hubAgentId: alice.id } })).rejects.toMatchObject({ status: 403, message: DELEGATE_HAS_NO_BUS })
        expect(await status(postMessage(await senderOf(alice), { to: [`agent:${child.id}`], type: 'FYI', idem_key: key(), body: 'hi' }))).toBe(404)
    })

    it('refuses a message carrying a token or a known secret, names only the label, and keeps the body out of rows, events and logs', async () => {
        const everosToken = ['everos', 'shared', '93f1c0aa71'].join('-')
        const foremanToken = ['foreman', 'hub', '4be0d2c917'].join('-')
        await writeFile(sharedEnvPath(), `EVEROS_TOKEN=${everosToken}\n`, 'utf8')
        holdHubToken(foremanToken)
        const stateless = `ghs_${'123456'}_${'eyJhbGciOiJSUzI1NiJ9'}.${'eyJpc3MiOiIxIn0'}.${'c2lnbmF0dXJl'}`
        const bodies = [
            `token ${stateless}`,
            `use github_pat_${'A1'.repeat(15)}`,
            `clone https://x-access-token:${'abc123def456'}@github.com/acme/app.git`,
            `the memory key is ${everosToken}`,
            `engine ${process.env.RERUN_API_KEY}`,
            `hub ${foremanToken}`,
        ]
        const lines: string[] = []
        const spies = (['info', 'warn', 'error'] as const).map(level => vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void lines.push(JSON.stringify(args))) as never))
        const from = await senderOf(alice)
        for (const body of bodies) {
            const post = postMessage(from, { to: [`agent:${bob.id}`], type: 'FYI', idem_key: key(), body })
            await expect(post).rejects.toMatchObject({ status: 403, code: 'bus_secret' })
            const message = await post.catch((err: Error) => err.message)
            expect(message).toMatch(/^refused: the message carries a secret \(/)
            for (const secret of [stateless, everosToken, foremanToken, process.env.RERUN_API_KEY!, 'abc123def456']) expect(message).not.toContain(secret)
        }
        await rm(sharedEnvPath(), { force: true })
        await mkdir(sharedEnvPath())
        await expect(postMessage(from, { to: [`agent:${bob.id}`], type: 'FYI', idem_key: key(), body: 'plain' })).rejects.toMatchObject({ status: 403, message: 'refused: the message carries a secret (Secret check unavailable)' })
        await rm(sharedEnvPath(), { recursive: true, force: true })
        spies.forEach(spy => spy.mockRestore())

        const stored = JSON.stringify([...(await rows('SELECT body FROM bus_messages')), ...(await rows('SELECT detail FROM bus_events'))]) + lines.join('\n')
        for (const body of bodies) expect(stored).not.toContain(body)
        expect(stored).not.toContain(everosToken)
        expect(stored).not.toContain('plain')
    })

    it('caps open requests per sender and recipient pair and the depth of a reply chain', async () => {
        const dave = await coworker('Dave')
        const from = await senderOf(alice)
        for (let i = 0; i < 2; i++) await postMessage(from, { to: [`agent:${dave.id}`], type: 'TASK', idem_key: key(), body: `task ${i}` })
        await expect(postMessage(from, { to: [`agent:${dave.id}`], type: 'QUESTION', idem_key: key(), body: 'third' })).rejects.toMatchObject({ status: 429, code: 'bus_pair_cap' })
        await expect(postMessage(from, { to: [`agent:${dave.id}#1`], type: 'TASK', idem_key: key(), body: 'to a copy' })).rejects.toMatchObject({ status: 429, code: 'bus_pair_cap' })
        expect(await status(postMessage(from, { to: [`agent:${dave.id}`], type: 'FYI', idem_key: key(), body: 'passive' }))).toBe('ok')

        const sides = [await senderOf(bob), await senderOf(carol)]
        let last = await postMessage(sides[0], { to: [`agent:${carol.id}`], type: 'FYI', idem_key: key(), body: 'hop 0' })
        for (let hop = 1; hop <= 6; hop++) {
            const side = sides[hop % 2]
            last = await postMessage(side, { to: [`agent:${hop % 2 ? bob.id : carol.id}`], type: 'FYI', re: last.id, idem_key: key(), body: `hop ${hop}` })
        }
        await expect(postMessage(sides[1], { to: [`agent:${bob.id}`], type: 'FYI', re: last.id, idem_key: key(), body: 'hop 7' })).rejects.toMatchObject({ status: 429, code: 'bus_depth' })
    })

    it('refuses untrusted requests to a switched-off recipient', async () => {
        const off = await coworker('Off', { enabled: false })
        const tainted = await senderOf(alice, { tainted: true })
        await expect(postMessage(tainted, { to: [`agent:${off.id}`], type: 'TASK', idem_key: key(), body: 'do it' })).rejects.toMatchObject({ status: 403, code: 'bus_disabled' })
        expect(await status(postMessage(await senderOf(alice), { to: [`agent:${off.id}`], type: 'TASK', idem_key: key(), body: 'do it' }))).toBe('ok')
    })
})
