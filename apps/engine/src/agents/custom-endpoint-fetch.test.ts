import { createOpenAI } from '@ai-sdk/openai'
import { APICallError, generateText } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { customEndpointFetch } from './custom-endpoint-fetch.js'
import { classifyProviderError } from '../runtime/provider-errors.js'

const XAI_NO_CREDITS = 'Your team 4021a7 has either used all available credits or reached its monthly spending limit.'

function answering(status: number, body: string, statusText = '') {
    return vi.fn(async () => new Response(body, { status, statusText, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }))
}

async function refusalOf(inner: ReturnType<typeof answering>): Promise<unknown> {
    const provider = createOpenAI({ apiKey: 'k', baseURL: 'https://api.x.ai/v1', fetch: customEndpointFetch(inner as unknown as typeof fetch) })
    return generateText({ model: provider.chat('grok-4.7'), prompt: 'hi', maxRetries: 0 }).catch(error => error)
}

describe('customEndpointFetch', () => {
    it("keeps xAI's own sentence on a 402 instead of the bare status text", async () => {
        const error = await refusalOf(answering(402, JSON.stringify({ code: 'The caller does not have permission to execute the specified operation', error: XAI_NO_CREDITS }), 'Payment Required'))
        expect(APICallError.isInstance(error)).toBe(true)
        expect((error as Error).message).toBe(`Provider returned error: ${XAI_NO_CREDITS}`)
        expect((error as APICallError).statusCode).toBe(402)
        expect(classifyProviderError('custom', error)).not.toBe('rerun_budget_exhausted')
    })

    it('names the status when the 402 has no body', async () => {
        const error = await refusalOf(answering(402, '', 'Payment Required'))
        expect((error as Error).message).toBe('Provider returned error: Payment Required')
    })

    it('reads at most 64 KiB of a 2 MiB 402 body and cancels the rest', async () => {
        const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
        let pulled = 0
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulled >= 2 * 1024 * 1024) return controller.close()
                pulled += chunk.byteLength
                controller.enqueue(chunk)
            },
            cancel() {
                cancelled = true
            },
        }, { highWaterMark: 0 })
        const inner = vi.fn(async () => new Response(body, { status: 402, statusText: 'Payment Required' }))
        const response = await customEndpointFetch(inner as unknown as typeof fetch)('https://api.x.ai/v1/chat/completions')
        const refusal = (await response.json()) as { error: { message: string } }
        expect(pulled).toBeLessThanOrEqual(128 * 1024)
        expect(cancelled).toBe(true)
        expect(new TextEncoder().encode(refusal.error.message).byteLength).toBeLessThanOrEqual(64 * 1024 + 'Provider returned error: '.length)
    })

    it('leaves any other answer untouched', async () => {
        const rateLimited = await customEndpointFetch(answering(429, '{"error":"slow down"}') as unknown as typeof fetch)('https://api.x.ai/v1/chat/completions')
        expect(rateLimited.status).toBe(429)
        expect(await rateLimited.text()).toBe('{"error":"slow down"}')

        const ok = await customEndpointFetch(answering(200, '{"ok":true}') as unknown as typeof fetch)('https://api.x.ai/v1/chat/completions')
        expect(await ok.text()).toBe('{"ok":true}')
    })

    it('waits as long as a slow local model needs', async () => {
        const inner = answering(200, '{}')
        await customEndpointFetch(inner as unknown as typeof fetch)('http://localhost:11434/v1/chat/completions')
        const init = (inner.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }])[1]
        expect(init.dispatcher).toBeDefined()
    })
})
