import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'

const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

const NON_PUBLIC = new BlockList()
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['224.0.0.0', 3],
] as const)
    NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
    ['::', 127],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
] as const)
    NON_PUBLIC.addSubnet(network, prefix, 'ipv6')

function isInternalHostname(host: string): boolean {
    const lower = host.toLowerCase().replace(/\.$/, '')
    return !lower.includes('.') || lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')
}

async function publicAddressesOf(hostname: string): Promise<LookupAddress[] | null> {
    const host = hostname.replace(/^\[|\]$/g, '')
    const ipFamily = isIP(host)
    if (!host || (!ipFamily && isInternalHostname(host))) return null
    try {
        const addresses = ipFamily ? [{ address: host, family: ipFamily }] : await lookup(host, { all: true })
        const allPublic = addresses.length > 0 && addresses.every(({ address, family }) => !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4'))
        return allPublic ? addresses : null
    } catch {
        return null
    }
}

export async function resolvesToPublicAddresses(hostname: string): Promise<boolean> {
    return (await publicAddressesOf(hostname)) !== null
}

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
    return (_hostname, options, callback) => {
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
    }
}

function pinnedDispatcher(addresses: LookupAddress[]): Agent {
    return new Agent({ connect: { lookup: pinnedLookup(addresses) } })
}

export async function assertPublicUrl(url: string): Promise<URL> {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol) || !(await resolvesToPublicAddresses(parsed.hostname))) throw new Error(`${parsed.host || url} is not a public host`)
    return parsed
}

async function checkedAddressesOf(url: string): Promise<LookupAddress[]> {
    const parsed = new URL(url)
    const addresses = /^https?:$/.test(parsed.protocol) ? await publicAddressesOf(parsed.hostname) : null
    if (!addresses) throw new Error(`${parsed.host || url} is not a public host`)
    return addresses
}

export async function isPublicHttpUrl(url: string): Promise<boolean> {
    try {
        const parsed = await assertPublicUrl(url)
        return !parsed.username && !parsed.password
    } catch {
        return false
    }
}

export async function fetchPublic(url: string, init: RequestInit = {}, { timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS }: { timeoutMs?: number; maxRedirects?: number } = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const followsRedirects = method === 'GET' || method === 'HEAD'
    let current = url
    for (let hop = 0; ; hop++) {
        const addresses = await checkedAddressesOf(current)
        const res = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), dispatcher: pinnedDispatcher(addresses) } as RequestInit)
        const location = res.headers.get('location')
        if (!followsRedirects || res.status < 300 || res.status >= 400 || !location || hop >= maxRedirects) return res
        current = new URL(location, current).toString()
    }
}
