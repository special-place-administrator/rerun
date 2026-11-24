import { randomBytes } from 'node:crypto'
import { customAlphabet } from 'nanoid'

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'

export const newId = customAlphabet(alphabet, 21)

export function slugify(input: string): string {
    return input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
}

export const nowIso = () => new Date().toISOString()

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now: number): string {
    let time = ''
    let rest = now
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[rest % 32] + time
        rest = Math.floor(rest / 32)
    }
    let random = ''
    for (const byte of randomBytes(16)) random += CROCKFORD[byte & 31]
    return time + random
}
