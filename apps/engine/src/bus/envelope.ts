import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isMessageId, isThreadId, isTopic } from './address.js'

export const BUS_VERSION = 1

export const BUS_TYPES = ['TASK', 'QUESTION', 'ANSWER', 'REVIEW', 'BLOCKER', 'DECISION', 'STATUS', 'FYI'] as const
export const BUS_VERDICTS = ['ACCEPT', 'REJECT', 'BLOCK', 'APPROVE'] as const

export type BusType = (typeof BUS_TYPES)[number]
export type BusVerdict = (typeof BUS_VERDICTS)[number]

const WAKING_TYPES: ReadonlySet<BusType> = new Set(['TASK', 'QUESTION', 'BLOCKER', 'DECISION'])

export const isActionable = (type: BusType, verdict?: BusVerdict | null): boolean => WAKING_TYPES.has(type) || (type === 'REVIEW' && !!verdict)

const BODY_MAX_BYTES = 3000
const REVIEW_BODY_MAX_BYTES = 6000
const MAX_RECIPIENTS = 8
const MAX_REFS = 8

const REF = /^[^\s<>"'`]{1,300}$/

export const postInputSchema = z
    .object({
        to: z.array(z.string()).min(1).max(MAX_RECIPIENTS),
        type: z.enum(BUS_TYPES),
        verdict: z.enum(BUS_VERDICTS).optional(),
        thread: z.string().refine(isThreadId).optional(),
        topic: z.string().refine(isTopic).optional(),
        re: z.string().refine(isMessageId).optional(),
        prio: z.number().int().min(0).max(3).optional(),
        ack_within_s: z.number().int().min(120).max(86_400).optional(),
        ttl_s: z.number().int().min(60).max(30 * 86_400).optional(),
        idem_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        body: z.string().min(1),
        refs: z.array(z.string().regex(REF)).max(MAX_REFS).optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (input.verdict && input.type !== 'REVIEW') ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'only a REVIEW carries a verdict' })
        const cap = input.type === 'REVIEW' ? REVIEW_BODY_MAX_BYTES : BODY_MAX_BYTES
        if (Buffer.byteLength(input.body, 'utf8') > cap) ctx.addIssue({ code: 'custom', path: ['body'], message: `body is over ${cap} bytes: put it in a file and link it in refs` })
    })

export type PostInput = z.infer<typeof postInputSchema>

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export const envelopeSha = (content: Record<string, unknown>): string => createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')
