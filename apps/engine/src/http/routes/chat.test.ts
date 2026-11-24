import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-chat-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_INSECURE_NO_AUTH = '1'

const state = vi.hoisted(() => ({
    calls: [] as { agent: { id: string; brief?: unknown; config?: { thinkingLevel?: string | null } }; sessionId: string; message: string; override: unknown; runId: string; trigger?: { userLanguage?: string; callableAgentIds?: string[] } }[],
    runAgentError: null as Error | null,
    startRunError: null as Error | null,
    usable: true,
}))

vi.mock('../../agents/availability.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../agents/availability.js')>()
    return { ...actual, isUsable: (...args: Parameters<typeof actual.isUsable>) => state.usable || actual.isUsable(...args) }
})

vi.mock('../../runtime/loop.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/loop.js')>()),
    runAgent: async (agent: { id: string; brief?: unknown; config?: { thinkingLevel?: string | null } }, sessionId: string, message: string, override: unknown, _writer: unknown, runId: string, trigger?: { userLanguage?: string; callableAgentIds?: string[] }) => {
        state.calls.push({ agent, sessionId, message, override, runId, trigger })
        if (state.runAgentError) throw state.runAgentError
        const { releaseSession } = await import('../../runtime/run-control.js')
        releaseSession(runId)
        return {
            runId,
            settled: Promise.resolve({ kind: 'done' }),
            result: {
                toUIMessageStream: () =>
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue({ type: 'start' })
                            controller.enqueue({ type: 'text-start', id: 't' })
                            controller.enqueue({ type: 'text-delta', id: 't', delta: 'hello from the mock' })
                            controller.enqueue({ type: 'text-end', id: 't' })
                            controller.enqueue({ type: 'finish' })
                            controller.close()
                        },
                    }),
            },
        }
    },
}))

vi.mock('../../db/repos/runs.js', async importOriginal => {
    const original = await importOriginal<typeof import('../../db/repos/runs.js')>()
    return {
        ...original,
        startRun: (...args: Parameters<typeof original.startRun>) => (state.startRunError ? Promise.reject(state.startRunError) : original.startRun(...args)),
    }
})

const { describe, expect, it, beforeAll, beforeEach } = await import('vitest')
const { mkdir, writeFile } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir, installPath } = await import('../../config/paths.js')
const { createSession, getSession, listSessions } = await import('../../db/repos/sessions.js')
const { getRun } = await import('../../db/repos/runs.js')
const { claimSession, releaseSession, sessionClaim, sessionClaimCount } = await import('../../runtime/run-control.js')
const { createConnection } = await import('../../connections/store.js')
const { clearBoxDefault, writeBoxDefault } = await import('../../connections/default.js')
const { DEFAULT_CONNECTION_MODELS } = await import('@moldwright/contracts')
const { recordCliModels } = await import('../../connections/cli-models.js')
const { resolveRunModel } = await import('../../agents/availability.js')

const id = 'chatagent'
const app = createServer()

function chat(agentId: string, body: unknown) {
    return app.request(`/agents/${agentId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function seed(agentId: string, config: Record<string, unknown>) {
    await mkdir(agentDir(agentId), { recursive: true })
    await writeAgentConfig(agentId, agentConfigSchema.parse(config))
}

beforeAll(async () => {
    await seed(id, { name: 'chat' })
    await seed('sleepy', { name: 'sleepy', enabled: false })
    await seed('boss', { name: 'boss', kind: 'foreman' })
    await seed('installer', { name: 'installer', setup: { required: true } })
    await writeFile(installPath('installer'), 'Connect Gmail.\n', 'utf8')
})

beforeEach(() => {
    state.calls.length = 0
    state.runAgentError = null
    state.startRunError = null
    state.usable = true
})

describe('POST /agents/:id/chat', () => {
    it('404s on an unknown agent', async () => {
        const res = await chat('ghost', { message: 'hi' })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'agent not found' })
    })

    it('refuses an agent that is switched off', async () => {
        const res = await chat('sleepy', { message: 'hi' })
        expect(res.status).toBe(403)
        expect(state.calls).toHaveLength(0)
    })

    it('rejects a body without a message', async () => {
        const res = await chat(id, { message: '' })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toMatch(/^message: /)
    })

    it('404s on a session the agent does not have', async () => {
        const res = await chat(id, { sessionId: 'nope', message: 'hi' })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'session not found for this agent' })
    })

    it('opens a dashboard session, streams the run and names both in the headers', async () => {
        const res = await chat(id, { message: 'hello' })
        expect(res.status).toBe(200)
        const sessionId = res.headers.get('x-session-id')!
        const runId = res.headers.get('x-run-id')!
        expect(await res.text()).toContain('hello from the mock')

        expect((await getSession(id, sessionId))?.source).toBe('dashboard')
        expect(await getRun(id, runId)).toMatchObject({ agentId: id, sessionId, status: 'running' })
        expect(state.calls).toEqual([expect.objectContaining({ sessionId, message: 'hello', runId, override: { connectionId: undefined, provider: undefined, model: undefined } })])
    })

    it('records the source the caller named', async () => {
        const res = await chat(id, { message: 'from the api', source: 'api' })
        await res.text()
        expect((await getSession(id, res.headers.get('x-session-id')!))?.source).toBe('api')
    })

    it('continues an existing session and forwards the model override', async () => {
        const session = await createSession(id, 'ongoing')
        const res = await chat(id, { sessionId: session.id, message: 'again', connectionId: 'cnx', provider: 'anthropic', model: 'claude-sonnet-4-6' })
        await res.text()
        expect(res.headers.get('x-session-id')).toBe(session.id)
        expect(state.calls[0].override).toEqual({ connectionId: 'cnx', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    })

    it('hands the brief to a foreman agent only', async () => {
        const brief = { instructions: 'Interview the user.', tools: [] }
        await (await chat('boss', { message: 'hi', foreman: brief })).text()
        expect(state.calls[0].agent.brief).toEqual(brief)

        await (await chat(id, { message: 'hi', foreman: brief })).text()
        expect(state.calls[1].agent.brief).toBeUndefined()
    })

    it('frees the session when the run row cannot be written', async () => {
        const session = await createSession(id, 'start fails')
        state.startRunError = new Error('disk is full')
        const res = await chat(id, { sessionId: session.id, message: 'hi' })
        expect(res.status).toBe(500)
        expect(state.calls).toHaveLength(0)
        expect(claimSession(session.id, 'next')).toBeNull()
        releaseSession('next')
    })

    it('frees the session when the run loop throws before it starts', async () => {
        const session = await createSession(id, 'run fails')
        state.runAgentError = new Error('no model available')
        const res = await chat(id, { sessionId: session.id, message: 'hi' })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('no model available')
        expect(claimSession(session.id, 'next')).toBeNull()
        releaseSession('next')
        expect(sessionClaimCount()).toBe(0)
    })

    it('runs one install per agent and points a second start at the conversation already running it', async () => {
        const first = await chat('installer', { message: 'install', install: true })
        expect(first.status).toBe(200)
        await first.text()
        const sessionId = first.headers.get('x-session-id')

        const second = await chat('installer', { message: 'install', install: true })
        expect(second.status).toBe(409)
        expect(await second.json()).toMatchObject({ code: 'install_in_flight', sessionId })
        expect(state.calls).toHaveLength(1)

        const other = await chat('installer', { message: 'something else' })
        expect(other.status).toBe(200)
        expect(other.headers.get('x-session-id')).not.toBe(sessionId)
    })

    it('hands the language of the user to the run that starts an install, and to no other', async () => {
        await seed('greeter', { name: 'greeter', setup: { required: true } })
        await writeFile(installPath('greeter'), 'Say hello.\n', 'utf8')

        await (await chat('greeter', { message: 'install', install: true, userLanguage: 'French' })).text()
        await (await chat(id, { message: 'hi', userLanguage: 'French' })).text()

        expect(state.calls.map(call => call.trigger?.userLanguage)).toEqual(['French', undefined])
    })

    it('hands the run the coworkers its author reaches, and nothing when the hub names none', async () => {
        await (await chat(id, { message: 'hi', callableAgentIds: ['agent-x'] })).text()
        await (await chat(id, { message: 'again' })).text()

        expect(state.calls.map(call => call.trigger?.callableAgentIds)).toEqual([['agent-x'], undefined])
    })

    it('runs one turn at the thinking level the request names and leaves the stored agent alone', async () => {
        await seed('thinker', { name: 'thinker', thinkingLevel: 'high' })

        await (await chat('thinker', { message: 'hi', thinkingLevel: 'low' })).text()
        await (await chat('thinker', { message: 'again' })).text()

        expect(state.calls.map(call => call.agent.config?.thinkingLevel)).toEqual(['low', 'high'])
    })

    it('sends a model alone so the coworker connection and provider are kept', async () => {
        await (await chat(id, { message: 'hi', model: 'claude-haiku-5-5' })).text()

        expect(state.calls[0].override).toEqual({ connectionId: undefined, provider: undefined, model: 'claude-haiku-5-5' })
    })

    it('refuses a thinking level outside low, medium, high', async () => {
        const res = await chat(id, { message: 'hi', thinkingLevel: 'extreme' })

        expect(res.status).toBe(400)
        expect(state.calls).toHaveLength(0)
    })

    it('refuses a coworker no connection can run, starts nothing, and runs it once the default picked under Providers is connected', async () => {
        state.usable = false
        const session = await createSession(id, undefined, undefined, 'dashboard')

        const refused = await chat(id, { sessionId: session.id, message: 'hi' })
        expect(refused.status).toBe(503)
        expect(((await refused.json()) as { error: string }).error).toMatch(/^No connection can run this coworker now/)
        expect(state.calls).toHaveLength(0)
        expect(sessionClaim(session.id)).toBeNull()

        const anthropic = await createConnection({ name: 'anthropic', provider: 'anthropic', models: DEFAULT_CONNECTION_MODELS.anthropic, extraModels: [], keys: { ANTHROPIC_API_KEY: 'k' } })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-5-5' })
        try {
            const ran = await chat(id, { sessionId: session.id, message: 'hi again' })
            expect(ran.status).toBe(200)
            await ran.text()
            expect(state.calls).toEqual([expect.objectContaining({ sessionId: session.id, message: 'hi again' })])
        } finally {
            await clearBoxDefault()
        }
    })

    it('runs a Claude model asked of a coworker on the model the non-Claude default serves, unless the caller named the connection', async () => {
        state.usable = false
        const codex = await createConnection({ name: 'codex', provider: 'codex', models: DEFAULT_CONNECTION_MODELS.codex, extraModels: [], keys: { CODEX_OAUTH_TOKEN: 't' } })
        recordCliModels(codex.id, ['gpt-6-luna'], '0.166.0', false)
        await writeBoxDefault({ connectionId: codex.id, model: 'gpt-6-luna' })
        try {
            const ran = await chat(id, { message: 'hi', model: 'claude-opus-5-5' })
            expect(ran.status).toBe(200)
            await ran.text()
            const [launched] = state.calls
            expect(await resolveRunModel(launched.agent as never, launched.override as never)).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' })
            expect((await chat(id, { message: 'hi', connectionId: codex.id, model: 'claude-opus-5-5' })).status).toBe(503)
        } finally {
            await clearBoxDefault()
        }
    })

    it('refuses a send pinned to a missing connection without running another, and runs once on it when it is back', async () => {
        state.usable = false
        const own = await createConnection({ name: 'own', provider: 'codex', models: DEFAULT_CONNECTION_MODELS.codex, extraModels: [], keys: { CODEX_OAUTH_TOKEN: 't' } })
        recordCliModels(own.id, ['gpt-6-luna'], '0.166.0', false)
        await seed('pinned', { name: 'pinned', provider: 'codex', connectionId: own.id, model: 'gpt-6-luna' })

        expect((await chat('pinned', { message: 'hi', connectionId: 'gone-default' })).status).toBe(503)
        expect((await chat('pinned', { message: 'hi', connectionId: 'gone-default' })).status).toBe(503)
        expect(state.calls).toHaveLength(0)
        expect(await listSessions('pinned')).toHaveLength(0)

        const back = await createConnection({ name: 'default', provider: 'codex', models: DEFAULT_CONNECTION_MODELS.codex, extraModels: [], keys: { CODEX_OAUTH_TOKEN: 't' } }, 'gone-default')
        recordCliModels(back.id, ['gpt-6-luna'], '0.166.0', false)
        const ran = await chat('pinned', { message: 'hi', connectionId: 'gone-default' })
        expect(ran.status).toBe(200)
        await ran.text()
        expect(state.calls).toHaveLength(1)
        expect((await resolveRunModel(state.calls[0].agent as never, state.calls[0].override as never)).connection?.id).toBe('gone-default')
    })
})
