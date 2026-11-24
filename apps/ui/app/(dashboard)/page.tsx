import { FactoryPage } from '@/components/factory/FactoryPage'
import { ACCOUNT_LINK_ERROR_PARAM, ACCOUNT_LINK_PROVIDER_PARAM, ACCOUNT_PARAM } from '@/lib/auth/link-intent'
import { routes } from '@/lib/routes'
import { redirect } from 'next/navigation'

type Search = Record<string, string | string[] | undefined>

const BOARD_LINK_PARAMS = ['template', 'billing', 'purchase', 'session_id', 'creator', 'connect', 'share', 'agent', 'tab', 'notification', 'rewind', 'prompt', ACCOUNT_PARAM, ACCOUNT_LINK_ERROR_PARAM, ACCOUNT_LINK_PROVIDER_PARAM]

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(await searchParams)) for (const item of typeof value === 'string' ? [value] : (value ?? [])) query.append(key, item)
    if (BOARD_LINK_PARAMS.some(key => query.has(key))) redirect(`${routes.board}?${query}`)
    return <FactoryPage />
}
