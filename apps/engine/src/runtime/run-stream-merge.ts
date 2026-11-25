import type { Usage } from '@moldwright/contracts'
import type { LanguageModelUsage, UIMessageChunk, UIMessageStreamWriter } from 'ai'
import { QUICK_REPLIES_TOOL, withHitlVersion } from '@moldwright/contracts'
import { canonicalHitlName, isHitlToolName } from '../tools/builtin/hitl.js'
import type { QuickRepliesCapture } from '../agents/quick-replies-stream.js'
import type { AgentRun, RunOutcome } from './loop.js'
import { redactSecrets, redactSecretsDeep } from '../lib/redact-secrets.js'

const CUT_GRACE_MS = 2_000

const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

const addUsage = (a: Usage | undefined, b: LanguageModelUsage): Usage => ({
    inputTokens: sum(a?.inputTokens, b.inputTokens),
    outputTokens: sum(a?.outputTokens, b.outputTokens),
    totalTokens: sum(a?.totalTokens, b.totalTokens),
    reasoningTokens: sum(a?.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: sum(a?.cachedInputTokens, b.cachedInputTokens),
})

function normalizeHitlStream(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
    return stream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform(chunk, controller) {
                const c = chunk as { type?: string; toolName?: string; input?: unknown }
                if (c.type === 'tool-input-start' && isHitlToolName(c.toolName)) {
                    controller.enqueue({ ...chunk, toolName: canonicalHitlName(c.toolName) } as UIMessageChunk)
                    return
                }
                if (c.type === 'tool-input-available' && isHitlToolName(c.toolName)) {
                    const toolName = canonicalHitlName(c.toolName)
                    controller.enqueue({ ...chunk, toolName, input: withHitlVersion(toolName, c.input) } as UIMessageChunk)
                    return
                }
                controller.enqueue(chunk)
            },
        }),
    )
}

const STREAMED_TEXT: Record<string, { field: 'delta' | 'inputTextDelta'; key: 'id' | 'toolCallId' }> = {
    'text-delta': { field: 'delta', key: 'id' },
    'reasoning-delta': { field: 'delta', key: 'id' },
    'tool-input-delta': { field: 'inputTextDelta', key: 'toolCallId' },
}
const STREAM_ENDS: Record<string, { delta: string; key: 'id' | 'toolCallId' }> = {
    'text-end': { delta: 'text-delta', key: 'id' },
    'reasoning-end': { delta: 'reasoning-delta', key: 'id' },
    'tool-input-available': { delta: 'tool-input-delta', key: 'toolCallId' },
    'tool-input-error': { delta: 'tool-input-delta', key: 'toolCallId' },
}

function withSecretsRedacted(stream: ReadableStream<UIMessageChunk>, secrets: readonly string[] | undefined): ReadableStream<UIMessageChunk> {
    if (!secrets?.length) return stream
    const holdBack = Math.max(...secrets.map(secret => secret.length)) - 1
    const pending = new Map<string, { chunk: Record<string, unknown>; field: string; text: string }>()
    const release = (controller: TransformStreamDefaultController<UIMessageChunk>, slot: string) => {
        const held = pending.get(slot)
        pending.delete(slot)
        if (held?.text) controller.enqueue({ ...held.chunk, [held.field]: held.text } as UIMessageChunk)
    }
    return stream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform(chunk, controller) {
                const fields = chunk as Record<string, unknown>
                const type = String(fields.type)
                const streamed = STREAMED_TEXT[type]
                if (streamed && typeof fields[streamed.field] === 'string') {
                    const slot = `${type}:${String(fields[streamed.key])}`
                    const text = redactSecrets(`${pending.get(slot)?.text ?? ''}${fields[streamed.field] as string}`, secrets)
                    const cut = Math.max(0, text.length - holdBack)
                    pending.set(slot, { chunk: fields, field: streamed.field, text: text.slice(cut) })
                    if (cut > 0) controller.enqueue({ ...chunk, [streamed.field]: text.slice(0, cut) } as UIMessageChunk)
                    return
                }
                const end = STREAM_ENDS[type]
                if (end) release(controller, `${end.delta}:${String(fields[end.key])}`)
                controller.enqueue(redactSecretsDeep(chunk, secrets))
            },
            flush(controller) {
                for (const slot of [...pending.keys()]) release(controller, slot)
            },
        }),
    )
}

export function withQuickReplies(stream: ReadableStream<UIMessageChunk>, read: (() => QuickRepliesCapture | undefined) | undefined): ReadableStream<UIMessageChunk> {
    if (!read) return stream
    return stream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform(chunk, controller) {
                if (chunk.type === 'finish') {
                    const capture = read()
                    if (capture) controller.enqueue({ type: 'tool-input-available', toolCallId: capture.toolCallId, toolName: QUICK_REPLIES_TOOL, input: { replies: capture.replies } })
                }
                controller.enqueue(chunk)
            },
        }),
    )
}

const isCleanFinish = (finishReason: string | undefined): boolean => finishReason === undefined || finishReason === 'stop' || finishReason === 'tool-calls'

export function cutOffWhenSettled(body: ReadableStream<UIMessageChunk>, settled: Promise<RunOutcome>): ReadableStream<UIMessageChunk> {
    const reader = body.getReader()
    let cutTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let aborted: UIMessageChunk | undefined
    return new ReadableStream<UIMessageChunk>({
        start(controller) {
            const finish = (outcome?: RunOutcome): void => {
                if (closed) return
                closed = true
                if (aborted && outcome?.kind !== 'error') controller.enqueue(aborted)
                if (outcome?.kind === 'error') controller.enqueue({ type: 'error', errorText: outcome.error ?? 'The run failed.' })
                try {
                    controller.close()
                } catch {
                }
                void reader.cancel().catch(() => {})
            }
            void settled.then(outcome => {
                if (outcome.kind === 'done' || closed) return
                cutTimer = setTimeout(() => finish(outcome), CUT_GRACE_MS)
            })
            void (async () => {
                let endedCleanly = false
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done || closed) break
                        if (value.type === 'abort') {
                            aborted = value
                            continue
                        }
                        if (value.type === 'finish') endedCleanly = isCleanFinish(value.finishReason)
                        controller.enqueue(value)
                    }
                } catch {
                } finally {
                    if (cutTimer) clearTimeout(cutTimer)
                    if (endedCleanly || closed) finish()
                    else void settled.then(finish)
                }
            })()
        },
        cancel(reason) {
            closed = true
            if (cutTimer) clearTimeout(cutTimer)
            return reader.cancel(reason)
        },
    })
}

export function mergeRunStream(writer: UIMessageStreamWriter, run: AgentRun, meta: { provider: string; model: string }): void {
    writer.merge(
        cutOffWhenSettled(
            withQuickReplies(
                withSecretsRedacted(
                    normalizeHitlStream(
                        run.result.toUIMessageStream({
                            messageMetadata: ({ part }) => {
                                if (part.type === 'finish-step') {
                                    const usage = addUsage(undefined, part.usage)
                                    const context = run.contextUsage?.()
                                    return { ...meta, usage: context ? { ...usage, context } : usage }
                                }
                                return undefined
                            },
                        }),
                    ),
                    run.secrets,
                ),
                run.quickReplies,
            ),
            run.settled,
        ),
    )
}
