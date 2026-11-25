// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FactorySnapshot } from '@moldwright/contracts'

const mocks = vi.hoisted(() => ({ clearFactoryQueueAction: vi.fn() }))

vi.mock('@/app/api/_actions/factory.actions', () => ({ clearFactoryQueueAction: mocks.clearFactoryQueueAction }))
vi.mock('./use-factory-controls', () => ({ thrown: () => ({ ok: false }) }))
vi.mock('@/hooks/useErrorText', () => ({ useErrorText: () => () => 'error' }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/dialogs/ConfirmDialog', () => ({
    ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? createElement('button', { 'data-confirm': '', onClick: onConfirm }, 'confirm') : null,
}))

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
    act(() => root?.unmount())
    root = null
    container?.remove()
})

describe('FactoryClearQueue', () => {
    it('shows a refused clear that the dispatcher filed under the requested project', async () => {
        mocks.clearFactoryQueueAction.mockResolvedValue({ ok: true, id: 'qc-1', count: 2 })
        const { FactoryClearQueue } = await import('./FactoryClearQueue')
        const controls = { view: { isOwner: true }, reload: vi.fn().mockResolvedValue(undefined) } as never
        const render = (snapshot: object) => root!.render(createElement(FactoryClearQueue, { snapshot: snapshot as FactorySnapshot, controls, issues: [5, 6] }))
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => render({ repo: 'acme/app' }))
        const status = () => container!.querySelector('[role="status"]')!.textContent

        await act(async () => container!.querySelector<HTMLButtonElement>('[data-clear-queue-button]')!.click())
        await act(async () => container!.querySelector<HTMLButtonElement>('[data-confirm]')!.click())
        expect(status()).toBe('queueClearWaiting')

        await act(async () => render({ repo: 'acme/app', queue_clear: { id: 'qc-1', repo: 'acme/other', outcome: 'wrong_project', cleared: [], kept: [], at: '2026-11-25T19:00:00Z' } }))
        expect(status()).toBe('queueClearRefusedProject')
        expect(container!.querySelector<HTMLButtonElement>('[data-clear-queue-button]')!.disabled).toBe(false)
    })
})
