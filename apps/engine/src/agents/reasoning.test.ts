import { describe, expect, it } from 'vitest'
import { applyCaching } from './caching.js'
import { mergeProviderOptions, reasoningProviderOptions } from './reasoning.js'

describe('reasoning provider options on OpenCode', () => {
    it('asks the way the format asks, and nothing on the chat format', () => {
        expect(reasoningProviderOptions('opencode', 'go/claude-haiku-5-5')).toEqual(reasoningProviderOptions('anthropic'))
        expect(reasoningProviderOptions('opencode', 'go/gpt-6-luna')).toEqual(reasoningProviderOptions('openai'))
        expect(reasoningProviderOptions('opencode', 'go/gemini-4-argon')).toEqual(reasoningProviderOptions('google'))
        expect(reasoningProviderOptions('opencode', 'go/deepseek-v4-pro')).toBeUndefined()
        expect(reasoningProviderOptions('opencode', 'go/unknown')).toBeUndefined()
    })
})

describe('reasoning provider options', () => {
    it('asks each API provider for its reasoning in its own dialect', () => {
        expect(reasoningProviderOptions('anthropic')).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
        expect(reasoningProviderOptions('openai')).toEqual({ openai: { reasoningSummary: 'auto' } })
        expect(reasoningProviderOptions('google')).toEqual({ google: { thinkingConfig: { includeThoughts: true } } })
    })

    it('leaves the providers that are configured elsewhere alone', () => {
        expect(reasoningProviderOptions('claude')).toBeUndefined()
        expect(reasoningProviderOptions('codex')).toBeUndefined()
        expect(reasoningProviderOptions('rerun')).toBeUndefined()
        expect(reasoningProviderOptions('openrouter')).toBeUndefined()
    })

    it('keeps the prompt cache key when both write under the same provider', () => {
        const cached = applyCaching('openai', { system: { stable: 'be useful', volatile: '' }, messages: [], sessionId: 'session-1' })

        expect(mergeProviderOptions(cached.providerOptions, { openai: { reasoningSummary: 'auto' } })).toEqual({
            openai: { promptCacheKey: 'session-1', reasoningSummary: 'auto' },
        })
    })

    it('merges when either side is missing', () => {
        expect(mergeProviderOptions(undefined, { openai: { reasoningSummary: 'auto' } })).toEqual({ openai: { reasoningSummary: 'auto' } })
        expect(mergeProviderOptions({ openai: { promptCacheKey: 'session-1' } }, undefined)).toEqual({ openai: { promptCacheKey: 'session-1' } })
        expect(mergeProviderOptions(undefined, undefined)).toBeUndefined()
    })

    it('does not touch the anthropic cache breakpoints, which may never land on a thinking block', () => {
        const cached = applyCaching('anthropic', { system: { stable: 'be useful', volatile: '' }, messages: [{ role: 'user', content: 'hi' }], sessionId: 'session-1' })
        const merged = mergeProviderOptions(cached.providerOptions, reasoningProviderOptions('anthropic'))

        expect(merged).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
        expect(cached.messages.filter(m => m.providerOptions?.anthropic)).toHaveLength(1)
        expect(cached.messages.at(-1)?.role).toBe('user')
    })
})

describe('reasoning provider options with a thinking level', () => {
    it('carries the level for the providers that take one', () => {
        expect(reasoningProviderOptions('anthropic', '', 'high')).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' } })
        expect(reasoningProviderOptions('openai', '', 'high')).toEqual({ openai: { reasoningSummary: 'auto', reasoningEffort: 'high' } })
        expect(reasoningProviderOptions('google', '', 'high')).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
    })

    it('ignores the level where the provider cannot take it', () => {
        expect(reasoningProviderOptions('codex', '', 'high')).toBeUndefined()
        expect(reasoningProviderOptions('opencode', 'go/deepseek-v4-pro', 'high')).toBeUndefined()
        expect(reasoningProviderOptions('opencode', 'go/claude-haiku-5-5', 'high')).toEqual(reasoningProviderOptions('anthropic', '', 'high'))
    })
})

// Claude 4.5 answers 400 to adaptive thinking (upstream #705); every later Claude model takes it.
describe('reasoning provider options on Claude 4.5', () => {
    it('asks a 4.5 model on OpenCode for no thinking, and every later one as before', () => {
        for (const model of ['console/claude-haiku-4-5', 'console/claude-sonnet-4-5', 'console/claude-opus-4-5']) expect(reasoningProviderOptions('opencode', model)).toBeUndefined()
        for (const model of ['console/claude-opus-4-6', 'console/claude-sonnet-4-6', 'console/claude-opus-5-5', 'go/qwen3.8-max']) expect(reasoningProviderOptions('opencode', model)).toEqual(reasoningProviderOptions('anthropic'))
    })

    it('asks a 4.5 model on an Anthropic key for no thinking, and every later one as before', () => {
        for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101']) expect(reasoningProviderOptions('anthropic', model)).toBeUndefined()
        for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) expect(reasoningProviderOptions('anthropic', model)).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
    })

    it('sends neither thinking nor a level to a 4.5 model when the coworker sets one', () => {
        for (const level of ['low', 'high', 'xhigh'] as const) {
            expect(reasoningProviderOptions('anthropic', 'claude-haiku-4-5-20251001', level)).toBeUndefined()
            expect(reasoningProviderOptions('opencode', 'console/claude-sonnet-4-5', level)).toBeUndefined()
        }
        expect(reasoningProviderOptions('anthropic', 'claude-sonnet-5-5', 'high')).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' } })
    })

    it('leaves the other providers as they were', () => {
        expect(reasoningProviderOptions('openai', 'gpt-6-sol', 'high')).toEqual({ openai: { reasoningSummary: 'auto', reasoningEffort: 'high' } })
        expect(reasoningProviderOptions('google', 'gemini-4-argon')).toEqual({ google: { thinkingConfig: { includeThoughts: true } } })
        expect(reasoningProviderOptions('openrouter', 'anthropic/claude-sonnet-5.5', 'high')).toBeUndefined()
    })
})
