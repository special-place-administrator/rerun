import { describe, expect, it } from 'vitest'
import { redactSecrets, redactSecretsDeep } from './redact-secrets.js'

describe('redactSecrets', () => {
    it('masks every occurrence of every secret', () => {
        expect(redactSecrets('a sk-live-123456 b sk-live-123456 c tok-abcdefgh', ['sk-live-123456', 'tok-abcdefgh'])).toBe('a [redacted] b [redacted] c [redacted]')
    })
})

describe('redactSecretsDeep', () => {
    it('masks secrets in nested tool output and message parts before they are stored or streamed', () => {
        const chunk = { type: 'tool-output-available', toolCallId: 'c1', output: { stdout: 'token=sk-live-123456', lines: ['ok', 'again sk-live-123456'] } }
        expect(redactSecretsDeep(chunk, ['sk-live-123456'])).toEqual({ type: 'tool-output-available', toolCallId: 'c1', output: { stdout: 'token=[redacted]', lines: ['ok', 'again [redacted]'] } })
    })

    it('keeps binary and class instances as they are', () => {
        const image = new Uint8Array([1, 2, 3])
        const at = new Date('2026-01-01T00:00:00Z')
        const out = redactSecretsDeep({ image, at, text: 'sk-live-123456' }, ['sk-live-123456'])
        expect(out.image).toBe(image)
        expect(out.at).toBe(at)
        expect(out.text).toBe('[redacted]')
    })

    it('returns the same value when there is no secret', () => {
        const message = { role: 'assistant', content: 'hello' }
        expect(redactSecretsDeep(message, [])).toBe(message)
    })
})
