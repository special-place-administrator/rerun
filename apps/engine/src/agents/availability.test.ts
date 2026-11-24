import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Provider } from '@moldwright/contracts'
import type { LoadedAgent } from './types.js'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-availability-'))
process.env.RERUN_HUB_BASE_URL = 'https://hub.example.com'
process.env.RERUN_API_KEY = 'hub-key'

const { beforeEach, describe, expect, it } = await import('vitest')
const { rm } = await import('node:fs/promises')
const { DEFAULT_CONNECTION_MODELS, RERUN_CONNECTION_ID, RERUN_MODEL, agentConfigSchema } = await import('@moldwright/contracts')
const { connectionsDir } = await import('../config/paths.js')
const { createConnection, ensureMoldwrightConnection } = await import('../connections/store.js')
const { getConnection } = await import('../connections/registry.js')
const { clearAgentCache } = await import('./registry.js')
const { clearBoxDefault, readBoxDefault, writeBoxDefault } = await import('../connections/default.js')
const { forgetCliModels, recordCliModels, recordRefusedModel } = await import('../connections/cli-models.js')
const { boxDefaultModel, defaultModelOf, isUsable, repairBoxDefault, resolveAutomationModel, resolveConfiguredModel, resolveRunModel } = await import('./availability.js')
const { updateConnectionKeys } = await import('../connections/store.js')

let seq = 0

async function connect(provider: Provider, keys: Record<string, string>, models = DEFAULT_CONNECTION_MODELS[provider]) {
    seq += 1
    return createConnection({ name: `${provider}-${seq}`, provider, models, extraModels: [], keys })
}

async function makeAgent(connectionId: string | null, provider: Provider | null, model: string | null): Promise<LoadedAgent> {
    const config = agentConfigSchema.parse({ name: 'a1', connectionId, provider, model })
    return { id: 'a1', config, soul: '', install: '', env: {}, resolved: await resolveConfiguredModel(config) }
}

function boxDefaultAgent(): Promise<LoadedAgent> {
    return makeAgent(null, null, null)
}

beforeEach(async () => {
    await clearBoxDefault()
    await rm(connectionsDir(), { recursive: true, force: true })
    clearAgentCache()
    seq = 0
})

describe('isUsable', () => {
    it('needs both a credential and the model on the connection', async () => {
        const withKey = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        expect(isUsable(withKey, 'claude-opus-4-8')).toBe(true)
        expect(isUsable(withKey, 'gpt-4o')).toBe(false)

        const withoutKey = await connect('anthropic', {})
        expect(isUsable(withoutKey, 'claude-opus-4-8')).toBe(false)
    })

    it('accepts a model the catalog does not know but the connection advertises', async () => {
        const connection = await createConnection({ name: 'custom router', provider: 'openrouter', models: [], extraModels: ['acme/router-large'], keys: { OPENROUTER_API_KEY: 'k' } })
        expect(isUsable(connection, 'acme/router-large')).toBe(true)
    })

    it('reads the keyless Rerun connection off the hub configuration', async () => {
        await ensureMoldwrightConnection()
        expect(isUsable(await getConnection(RERUN_CONNECTION_ID), RERUN_MODEL)).toBe(true)
    })

    it('is false for an agent with no connection at all', () => {
        expect(isUsable(null, RERUN_MODEL)).toBe(false)
    })
})

describe('resolveAutomationModel', () => {
    it('leaves an available request untouched', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-sonnet-4-6')
        expect(await resolveAutomationModel(agent, { connectionId: anthropic.id, model: 'claude-opus-4-8' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-opus-4-8',
        })
    })

    it('falls back to the agent default when the requested connection lost its credential', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-opus-4-8')
        expect(await resolveAutomationModel(agent, { connectionId: claude.id, model: 'opus' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-opus-4-8',
        })
    })

    it('falls back to Rerun before any other connection', async () => {
        await ensureMoldwrightConnection()
        await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({ connectionId: RERUN_CONNECTION_ID, provider: 'rerun', model: RERUN_MODEL })
    })

    it('treats Rerun as the default when none was saved, as Providers shows, and never runs another connection', async () => {
        await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({ connectionId: claude.id, provider: 'claude', model: 'opus' })
        const unpinned = (await boxDefaultAgent()).resolved
        expect(unpinned).toMatchObject({ provider: 'rerun', model: RERUN_MODEL })
        expect(isUsable(unpinned.connection, unpinned.model)).toBe(false)
    })

    it('rejects a model the connection was curated to exclude', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-sonnet-4-6'])
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-sonnet-4-6')
        expect(await resolveAutomationModel(agent, { connectionId: anthropic.id, model: 'claude-opus-4-8' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
        })
    })

    it('keeps failing as before when nothing on the box is usable', async () => {
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({ connectionId: claude.id, provider: 'claude', model: 'opus' })
    })
})

describe('boxDefaultModel', () => {
    it('answers what the owner set', async () => {
        await ensureMoldwrightConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await boxDefaultModel()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('keeps a default whose credential is gone instead of picking another connection', async () => {
        await ensureMoldwrightConnection()
        const claude = await connect('claude', {})
        await writeBoxDefault({ connectionId: claude.id, model: 'opus' })
        const dead = await boxDefaultModel()
        expect(dead).toMatchObject({ connection: { id: claude.id }, provider: 'claude', model: 'opus' })
        expect(isUsable(dead.connection, dead.model)).toBe(false)
    })

    it('keeps a default naming a model the connection no longer offers instead of picking another connection', async () => {
        await ensureMoldwrightConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-sonnet-4-6'])
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        const dead = await boxDefaultModel()
        expect(dead).toMatchObject({ connection: { id: anthropic.id }, provider: 'anthropic', model: 'claude-opus-4-8' })
        expect(isUsable(dead.connection, dead.model)).toBe(false)
    })

    it('falls back to Rerun when nothing was ever set', async () => {
        await ensureMoldwrightConnection()
        expect(await boxDefaultModel()).toMatchObject({ provider: 'rerun', model: RERUN_MODEL })
    })

    it('reads exactly like the old hardcoded defaults on a box with nothing plugged in', async () => {
        expect(await boxDefaultModel()).toEqual({ connection: null, provider: 'rerun', model: RERUN_MODEL })
    })
})

describe('resolveConfiguredModel', () => {
    it('follows the box default when the agent named no model', async () => {
        await ensureMoldwrightConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await resolveConfiguredModel((await boxDefaultAgent()).config)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('ignores a leftover connectionId sitting next to a null model', async () => {
        await ensureMoldwrightConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const stale = await connect('claude', { CLAUDE_CODE_OAUTH_TOKEN: 't' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        const config = agentConfigSchema.parse({ name: 'a1', connectionId: stale.id, provider: 'claude', model: null })
        expect(await resolveConfiguredModel(config)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('returns a pin as asked even when its credential was pulled, rather than swapping it', async () => {
        const claude = await connect('claude', {})
        expect(await resolveConfiguredModel((await makeAgent(claude.id, 'claude', 'opus')).config)).toMatchObject({ connection: claude, provider: 'claude', model: 'opus' })
    })

    it('still maps a bare provider onto the oldest connection of that provider', async () => {
        const first = await connect('anthropic', { ANTHROPIC_API_KEY: 'k1' })
        await new Promise(resolve => setTimeout(resolve, 2))
        await connect('anthropic', { ANTHROPIC_API_KEY: 'k2' })
        const resolved = await resolveConfiguredModel(agentConfigSchema.parse({ name: 'a1', provider: 'anthropic', model: 'claude-opus-4-8' }))
        expect(resolved.connection?.id).toBe(first.id)
    })
})

describe('resolveAutomationModel over a box-default agent', () => {
    it('runs the box default when the automation names no model of its own', async () => {
        await ensureMoldwrightConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await resolveAutomationModel(await boxDefaultAgent(), undefined)).toEqual({ connectionId: anthropic.id, provider: 'anthropic', model: 'claude-opus-4-8' })
    })
})

const CHATGPT_PLAN_MODELS = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']

async function chatgpt(served: string[] | null = CHATGPT_PLAN_MODELS) {
    const connection = await connect('codex', { CODEX_OAUTH_TOKEN: 't' })
    forgetCliModels(connection.id)
    if (served) recordCliModels(connection.id, served, '0.166.0', false)
    return connection
}

describe('a ChatGPT plan that leaves models out', () => {
    it('defaults to the first model the account serves', async () => {
        expect(defaultModelOf(await chatgpt())).toBe('gpt-6-luna')
    })

    it('does not count a model the account refuses as usable', async () => {
        const codex = await chatgpt()
        expect(isUsable(codex, 'gpt-6-sol')).toBe(false)
        expect(isUsable(codex, 'gpt-6-luna')).toBe(true)
    })

    it('runs a refused stored default on a served model of the same connection, not on Rerun', async () => {
        await ensureMoldwrightConnection()
        const codex = await chatgpt()
        await writeBoxDefault({ connectionId: codex.id, model: 'gpt-6-sol' })
        expect(await boxDefaultModel()).toMatchObject({ connection: { id: codex.id }, provider: 'codex', model: 'gpt-6-luna' })
    })

    it('moves a refused stored default to a served model', async () => {
        const codex = await chatgpt()
        await writeBoxDefault({ connectionId: codex.id, model: 'gpt-6-sol' })
        await repairBoxDefault(codex)
        expect(await readBoxDefault()).toEqual({ connectionId: codex.id, model: 'gpt-6-luna' })
    })

    it('leaves a served default, another connection, and a connection never read alone', async () => {
        const read = await chatgpt()
        await writeBoxDefault({ connectionId: read.id, model: 'gpt-5.6-terra' })
        await repairBoxDefault(read)
        expect(await readBoxDefault()).toEqual({ connectionId: read.id, model: 'gpt-5.6-terra' })

        const unread = await chatgpt(null)
        await writeBoxDefault({ connectionId: unread.id, model: 'gpt-6-sol' })
        await repairBoxDefault(read)
        await repairBoxDefault(unread)
        expect(await readBoxDefault()).toEqual({ connectionId: unread.id, model: 'gpt-6-sol' })
    })

    it('stops serving a model a run was refused on, though the list announced it', async () => {
        const codex = await chatgpt(DEFAULT_CONNECTION_MODELS.codex)
        await writeBoxDefault({ connectionId: codex.id, model: 'gpt-6-sol' })
        recordRefusedModel(codex.id, 'gpt-6-sol')
        await repairBoxDefault(codex)
        expect(await readBoxDefault()).toEqual({ connectionId: codex.id, model: 'gpt-6.1-sol' })
    })

    it('runs a pin on a refused model, and its automations, on the Providers default without rewriting the pin', async () => {
        const codex = await chatgpt()
        await writeBoxDefault({ connectionId: codex.id, model: 'gpt-6-luna' })
        const pinned = await makeAgent(codex.id, 'codex', 'gpt-6-sol')
        expect(pinned.resolved).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' })
        expect(pinned.config.model).toBe('gpt-6-sol')
        expect(await resolveAutomationModel(pinned, { connectionId: codex.id, model: 'gpt-6-sol' })).toEqual({ connectionId: codex.id, provider: 'codex', model: 'gpt-6-luna' })
    })
})

describe('a pin that cannot run follows the default picked under Providers', () => {
    async function withDefault() {
        await ensureMoldwrightConnection()
        const claude = await connect('claude', { CLAUDE_CODE_OAUTH_TOKEN: 't' })
        await writeBoxDefault({ connectionId: claude.id, model: 'claude-opus-5-5' })
        return claude
    }

    it('keeps a healthy pin on its own connection', async () => {
        await withDefault()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        expect((await makeAgent(anthropic.id, 'anthropic', 'claude-opus-4-8')).resolved).toMatchObject({ connection: { id: anthropic.id }, model: 'claude-opus-4-8' })
    })

    it('moves a pin whose connection lost its credential onto the default, keeping the saved pin', async () => {
        const claude = await withDefault()
        const pulled = await connect('anthropic', {})
        const agent = await makeAgent(pulled.id, 'anthropic', 'claude-opus-4-8')
        expect(agent.resolved).toMatchObject({ connection: { id: claude.id }, provider: 'claude', model: 'claude-opus-5-5' })
        expect(agent.config).toMatchObject({ connectionId: pulled.id, model: 'claude-opus-4-8' })
    })

    it('moves a pin on a deleted connection to its provider first, else onto the default', async () => {
        const claude = await withDefault()
        expect((await makeAgent('95h6rpo13p1hztskqfxsx', 'claude', 'claude-sonnet-5-5')).resolved).toMatchObject({ connection: { id: claude.id }, model: 'claude-sonnet-5-5' })
        expect((await makeAgent('95h6rpo13p1hztskqfxsx', 'anthropic', 'claude-opus-4-8')).resolved).toMatchObject({ connection: { id: claude.id }, model: 'claude-opus-5-5' })
    })

    it('moves a pin whose model the connection no longer offers onto the default', async () => {
        const claude = await withDefault()
        const narrowed = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-sonnet-4-6'])
        expect((await makeAgent(narrowed.id, 'anthropic', 'claude-opus-4-8')).resolved).toMatchObject({ connection: { id: claude.id }, model: 'claude-opus-5-5' })
    })

    it('keeps the pin, never another provider, when the default cannot run either', async () => {
        await ensureMoldwrightConnection()
        const deadDefault = await connect('claude', {})
        await writeBoxDefault({ connectionId: deadDefault.id, model: 'claude-opus-5-5' })
        const pulled = await connect('anthropic', {})
        expect((await makeAgent(pulled.id, 'anthropic', 'claude-opus-4-8')).resolved).toMatchObject({ connection: { id: pulled.id }, model: 'claude-opus-4-8' })
    })

    it('gives an agent with no pin the default even when it cannot run, never another connection, and runs it once it is connected again', async () => {
        await ensureMoldwrightConnection()
        await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const deadDefault = await connect('claude', {})
        await writeBoxDefault({ connectionId: deadDefault.id, model: 'claude-opus-5-5' })
        const dead = (await boxDefaultAgent()).resolved
        expect(dead).toMatchObject({ connection: { id: deadDefault.id }, provider: 'claude', model: 'claude-opus-5-5' })
        expect(isUsable(dead.connection, dead.model)).toBe(false)
        await updateConnectionKeys(deadDefault.id, { set: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, remove: [] })
        const back = (await boxDefaultAgent()).resolved
        expect(back).toMatchObject({ connection: { id: deadDefault.id }, model: 'claude-opus-5-5' })
        expect(isUsable(back.connection, back.model)).toBe(true)
    })

    it('returns to the pin once its connection is usable again', async () => {
        const claude = await withDefault()
        const pulled = await connect('anthropic', {})
        expect((await makeAgent(pulled.id, 'anthropic', 'claude-opus-4-8')).resolved.connection?.id).toBe(claude.id)
        await updateConnectionKeys(pulled.id, { set: { ANTHROPIC_API_KEY: 'k' }, remove: [] })
        expect((await makeAgent(pulled.id, 'anthropic', 'claude-opus-4-8')).resolved).toMatchObject({ connection: { id: pulled.id }, model: 'claude-opus-4-8' })
    })

    it('launches a model-only override on the connection the agent resolved to, not the dead pin', async () => {
        const claude = await withDefault()
        const agent = await makeAgent((await connect('anthropic', {})).id, 'anthropic', 'claude-opus-4-8')
        expect(await resolveRunModel(agent, { model: 'claude-sonnet-5-5' })).toMatchObject({ connection: { id: claude.id }, provider: 'claude', model: 'claude-sonnet-5-5' })
    })

    it('gives a connection-only override the stored default model that connection serves', async () => {
        const claude = await withDefault()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-opus-4-8')
        expect(await resolveRunModel(agent, { connectionId: claude.id })).toMatchObject({ connection: { id: claude.id }, provider: 'claude', model: 'claude-opus-5-5' })
    })
})
