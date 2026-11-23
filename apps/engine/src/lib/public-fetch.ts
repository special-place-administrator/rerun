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
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
] as const)
    NON_PUBLIC.addSubnet(network, prefix, 'ipv6')

export class NonPublicHostError extends Error {
    constructor(host: string) {
        super(`${host} is not a public host`)
        this.name = 'NonPublicHostError'
    }
}

export const isHttpUrl = (url: string): boolean => {
    try {
        return /^https?:$/.test(new URL(url).protocol)
    } catch {
        return false
    }
}

function unmapIpv6(address: string): string {
    const m = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    if (m) return m[1]
    const mHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
    if (mHex) {
        const high = parseInt(mHex[1], 16)
        const low = parseInt(mHex[2], 16)
        return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`
    }
    return address
}

async function publicAddressesOf(hostname: string): Promise<LookupAddress[] | null> {
    const host = hostname.replace(/^\[|\]$/g, '')
    try {
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })
        const allPublic = addresses.length > 0 && addresses.every(({ address, family }) => {
            const unmapped = unmapIpv6(address)
            const fam = isIP(unmapped)
            return fam === 4 ? !NON_PUBLIC.check(unmapped, 'ipv4') : fam === 6 ? !NON_PUBLIC.check(unmapped, 'ipv6') : false
        })
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
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new NonPublicHostError(url)
    }
    if (!/^https?:$/.test(parsed.protocol) || !(await resolvesToPublicAddresses(parsed.hostname))) throw new NonPublicHostError(parsed.host || url)
    return parsed
}

async function checkedAddressesOf(url: string): Promise<LookupAddress[]> {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new NonPublicHostError(url)
    }
    const addresses = /^https?:$/.test(parsed.protocol) ? await publicAddressesOf(parsed.hostname) : null
    if (!addresses) throw new NonPublicHostError(parsed.host || url)
    return addresses
}

export async function fetchPublic(url: string, init: RequestInit = {}, { timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS }: { timeoutMs?: number; maxRedirects?: number } = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const followsRedirects = method === 'GET' || method === 'HEAD'
    let current = url
    for (let hop = 0; ; hop++) {
        const addresses = await checkedAddressesOf(current)
        const res = await fetch(current, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(timeoutMs), dispatcher: pinnedDispatcher(addresses) } as RequestInit)
        const location = res.headers.get('location')
        if (!followsRedirects || res.status < 300 || res.status >= 400 || !location || hop >= maxRedirects) return res
        current = new URL(location, current).toString()
    }
}
