export type BusAddress =
    | { kind: 'agent'; id: string; copy?: number }
    | { kind: 'station'; slug: string }
    | { kind: 'role'; slug: string }
    | { kind: 'group'; role?: string }
    | { kind: 'svc'; name: 'bus' | 'factory' }
    | { kind: 'user'; id: string }

const SLUG = '[a-z0-9][a-z0-9-]{0,63}'
const AGENT = new RegExp(`^agent:(${SLUG})(?:#([1-9][0-9]?))?$`)
const STATION = new RegExp(`^station:(${SLUG})$`)
const ROLE = new RegExp(`^role:(${SLUG})$`)
const GROUP_ROLE = new RegExp(`^@role:(${SLUG})$`)
const SVC = /^svc:(bus|factory)$/
const USER = /^user:([A-Za-z0-9-]{1,64})$/

const MAX_COPY_INDEX = 64

export const FACTORY_SERVICE = 'svc:factory'

export function parseAddress(text: string): BusAddress | null {
    const agent = AGENT.exec(text)
    if (agent) {
        const copy = agent[2] === undefined ? undefined : Number(agent[2])
        if (copy !== undefined && copy > MAX_COPY_INDEX) return null
        return copy === undefined ? { kind: 'agent', id: agent[1] } : { kind: 'agent', id: agent[1], copy }
    }
    const station = STATION.exec(text)
    if (station) return { kind: 'station', slug: station[1] }
    const role = ROLE.exec(text)
    if (role) return { kind: 'role', slug: role[1] }
    if (text === '@all') return { kind: 'group' }
    const groupRole = GROUP_ROLE.exec(text)
    if (groupRole) return { kind: 'group', role: groupRole[1] }
    const svc = SVC.exec(text)
    if (svc) return { kind: 'svc', name: svc[1] as 'bus' | 'factory' }
    const user = USER.exec(text)
    if (user) return { kind: 'user', id: user[1] }
    return null
}

export function isConcrete(address: BusAddress): boolean {
    return address.kind === 'agent' || address.kind === 'svc' || address.kind === 'user'
}

export function agentAddress(id: string, copy?: number): string {
    return copy === undefined ? `agent:${id}` : `agent:${id}#${copy}`
}

const ULID = '[0-9A-HJKMNP-TV-Z]{26}'
const THREAD = new RegExp(`^(?:th_${ULID}|call:${ULID}|fx:[A-Za-z0-9_.-]{1,64}/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9})$`)
const MESSAGE_ID = new RegExp(`^m_${ULID}$`)
const TOPIC = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){0,3}$/

export const isThreadId = (text: string): boolean => THREAD.test(text)
export const isFactoryThread = (thread: string): boolean => thread.startsWith('fx:')
export const isMessageId = (text: string): boolean => MESSAGE_ID.test(text)
export const isTopic = (text: string): boolean => TOPIC.test(text)
