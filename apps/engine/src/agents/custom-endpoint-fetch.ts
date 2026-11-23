import { Agent as UndiciAgent } from 'undici'
import { refusalMessageOf, refusalResponse } from '../lib/refusal-body.js'

const CUSTOM_ENDPOINT_PATIENCE_MS = 60 * 60_000
const MAX_402_BODY_BYTES = 64 * 1024
const customEndpointDispatcher = new UndiciAgent({ headersTimeout: CUSTOM_ENDPOINT_PATIENCE_MS, bodyTimeout: CUSTOM_ENDPOINT_PATIENCE_MS })

async function boundedText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let remaining = maxBytes
    try {
        while (remaining > 0) {
            const { done, value } = await reader.read()
            if (done) break
            const part = value.byteLength > remaining ? value.subarray(0, remaining) : value
            remaining -= part.byteLength
            text += decoder.decode(part, { stream: true })
        }
        return text + decoder.decode()
    } finally {
        await reader.cancel().catch(() => undefined)
    }
}

export function customEndpointFetch(inner: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
        const response = await inner(input, { ...init, dispatcher: customEndpointDispatcher } as RequestInit)
        if (response.status !== 402) return response
        const text = await boundedText(response, MAX_402_BODY_BYTES)
        const reason = refusalMessageOf(text) || response.statusText || 'Payment Required'
        return refusalResponse(response, text, `Provider returned error: ${reason}`, 'custom')
    }
}
