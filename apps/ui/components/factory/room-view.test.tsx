// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { roomDetailSchema, roomSummarySchema } from '@moldwright/contracts'
import { RoomView } from './RoomView'
import { RoomList } from './RoomList'

const T = '2026-11-14T12:00:00Z'
const member = (agentId: string, name: string) => ({ agentId, name, tokensIn: 6, tokensOut: 4 })
const members = [member('a', 'Dieter'), member('b', 'Ada'), member('c', 'Grace')]
const post = (seq: number, round: number, over: Record<string, unknown> = {}) => ({
    id: `p${seq}`, seq, round, kind: 'post', authorKind: 'coworker', authorId: 'a', authorName: 'Dieter', text: `post ${seq}`, createdAt: T, ...over,
})
const detail = (over: Record<string, unknown> = {}) => roomDetailSchema.parse({
    id: 'r1', title: 'Pick a queue', job: null, openedBy: 'user', status: 'open', round: 1, members,
    lastPost: null, createdAt: T, closesAt: T, closedAt: null, question: 'Which queue?', decision: null,
    posts: [post(1, 1), post(2, 1), post(3, 1), post(4, 2), post(5, 2), post(6, 2)], ...over,
})
const summary = (over: Record<string, unknown> = {}) => roomSummarySchema.parse({
    id: 'r1', title: 'Pick a queue', job: null, openedBy: 'user', status: 'open', round: 1, members,
    lastPost: null, createdAt: T, closesAt: T, closedAt: null, ...over,
})

let host: HTMLDivElement
let root: Root
const view = (room: ReturnType<typeof detail>, onSend: (t: string) => void = () => {}) => act(() => { root.render(createElement(RoomView, { room, onSend })) })
const list = (rooms: ReturnType<typeof summary>[], onOpen: (id: string) => void = () => {}) => act(() => { root.render(createElement(RoomList, { rooms, onOpen })) })
const q = (sel: string) => host.querySelector(sel)
const type = (el: HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
    act(() => root.unmount())
    host.remove()
})

describe('RoomView', () => {
    it('shows who is in the room and what each cost', () => {
        view(detail())
        expect(host.querySelectorAll('[data-member]')).toHaveLength(3)
        expect(q('[data-member="b"]')?.textContent).toContain('Ada')
        expect(q('[data-member="b"]')?.textContent).toContain('6 in / 4 out')
        expect(q('[data-room-cost]')?.textContent).toBe('Cost: 18 in / 12 out')
    })

    it('shows the posts in order with their rounds', () => {
        view(detail())
        const posts = Array.from(host.querySelectorAll('[data-post]'))
        expect(posts.map((p) => p.getAttribute('data-post'))).toEqual(['1', '2', '3', '4', '5', '6'])
        expect(posts[0].textContent).toContain('Round 1')
        expect(posts[3].textContent).toContain('Round 2')
        expect(posts[0].textContent).toContain('Dieter')
        expect(posts[0].textContent).toContain('post 1')
    })

    it('lets the user write while the room is open', () => {
        const onSend = vi.fn()
        view(detail(), onSend)
        const box = q('textarea') as HTMLTextAreaElement
        const send = q('[data-room-send]') as HTMLButtonElement
        expect(send.textContent).toBe('Send')
        act(() => send.click())
        expect(onSend).not.toHaveBeenCalled()
        type(box, '  please weigh cost ')
        act(() => send.click())
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith('please weigh cost')
        expect(box.value).toBe('')
        expect(q('[data-room-closed]')).toBeNull()
        expect(q('[data-room-status]')?.textContent).toBe('Open')
    })

    it('is read-only once decided, with the decision shown', () => {
        view(detail({ status: 'decided', decision: 'Use the queue', posts: [post(1, 1), post(2, 2, { kind: 'decision', text: 'Use the queue' })] }))
        expect(q('[data-decision]')?.textContent).toContain('Use the queue')
        expect(q('[data-room-status]')?.getAttribute('data-room-status')).toBe('decided')
        expect(q('[data-room-status]')?.textContent).toBe('Decided')
        expect(q('textarea')).toBeNull()
        expect(q('[data-room-send]')).toBeNull()
        expect(q('[data-room-closed]')?.textContent).toBe('This room is closed. You can read it.')
    })

    it('labels a presented and an expired room', () => {
        view(detail({ status: 'presented' }))
        expect(q('[data-room-status]')?.textContent).toBe('Presented to you')
        view(detail({ status: 'expired' }))
        expect(q('[data-room-status]')?.textContent).toBe('Closed: time limit')
    })
})

describe('RoomList', () => {
    it('lists rooms with initials, a capitalised preview and closed state', () => {
        const onOpen = vi.fn()
        list([
            summary({ id: 'r1', lastPost: { authorName: 'Dieter', text: 'Three rulings.' } }),
            summary({ id: 'r2', status: 'decided' }),
        ], onOpen)
        const first = q('[data-room="r1"]') as HTMLElement
        expect(first.textContent).toContain('DAG')
        expect(first.textContent).toContain('Pick a queue')
        expect(first.textContent).toContain('DIETER: Three rulings.')
        expect(first.textContent).not.toContain('Closed')
        expect(q('[data-room="r2"]')?.textContent).toContain('Closed')
        act(() => (q('[data-room="r2"]') as HTMLElement).click())
        expect(onOpen).toHaveBeenCalledWith('r2')
        list([])
        expect(host.textContent).toBe('No rooms for this job yet')
    })
})
