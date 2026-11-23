import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { env } from '../config/env.js'
import { desktopTokenMatches } from '../desktop/session.js'

function apiKeyMatches(token: string, key: string): boolean {
    if (!token) return false
    const left = createHash('sha256').update(token, 'utf8').digest()
    const right = createHash('sha256').update(key, 'utf8').digest()
    return timingSafeEqual(left, right)
}

const DESKTOP_APPS_PATH = /^\/agents\/([^/]+)\/desktop\/apps$/

function isDesktopPanelRequest(method: string, path: string, token: string): boolean {
    if (method !== 'POST') return false
    const segment = DESKTOP_APPS_PATH.exec(path)?.[1]
    if (segment === undefined) return false
    let agentId: string
    try {
        agentId = decodeURIComponent(segment)
    } catch {
        return false
    }
    return desktopTokenMatches(agentId, token)
}

export const auth: MiddlewareHandler = async (c, next) => {
    const key = env().RERUN_API_KEY
    if (!key) {
        if (process.env.RERUN_INSECURE_NO_AUTH === '1') return next()
        return c.json({ error: 'Unauthorized' }, 401)
    }
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : header
    if (!apiKeyMatches(token, key) && !isDesktopPanelRequest(c.req.method, c.req.path, token)) return c.json({ error: 'Unauthorized' }, 401)
    return next()
}
