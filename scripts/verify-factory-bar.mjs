#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BAR_FIT_SLACK, BAR_NATURAL_WIDTH, BAR_PANE_FLOOR, BAR_TIERS } from '../apps/ui/components/factory/factory-bar-tiers.ts'
import { PORT, REPO_ROOT, assertLocalProfile, assertMigrated, chromium, ensureServer, fail, linkTestEngine, localStack, log, signIn, testAccount } from './verify/shared.mjs'

const PANES = [BAR_PANE_FLOOR, 614, 632, 792, 1254, 1262, 1902].sort((a, b) => a - b)
const TIER_CHAIN = [['t1', 't0'], ['t2', 't1'], ['t3', 't2']]
for (const [tier, wider] of TIER_CHAIN) {
    if (BAR_TIERS[tier].below !== BAR_NATURAL_WIDTH[wider] + BAR_FIT_SLACK) fail(`${tier} starts below ${BAR_TIERS[tier].below} px, not at the ${wider} natural width ${BAR_NATURAL_WIDTH[wider]} + ${BAR_FIT_SLACK}.`)
}
const tierAt = (pane) => TIER_CHAIN.reduce((tier, [narrower]) => (pane < BAR_TIERS[narrower].below ? narrower : tier), 't0')
const HEIGHT = 800
const SETTLE_MS = 500

function parseArgs(argv) {
    const options = { base: null, pages: ['/'], executablePath: undefined }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--base') options.base = argv[++i]
        else if (arg === '--pages') options.pages = argv[++i].split(',')
        else if (arg === '--browser') options.executablePath = argv[++i]
        else fail(`Unknown argument: ${arg}`)
    }
    return options
}

const paneWidth = () => Math.round(document.querySelector('[data-bar-frame="top"]').getBoundingClientRect().width)

async function sizePane(page, pane) {
    let viewport = pane
    for (let attempt = 0; attempt < 4; attempt++) {
        await page.setViewportSize({ width: viewport, height: HEIGHT })
        await page.waitForTimeout(SETTLE_MS)
        const width = await page.evaluate(paneWidth)
        if (width === pane) return
        viewport += pane - width
    }
    fail(`Could not size the factory pane to ${pane} px.`)
}

function measure() {
    const fit = (edge, items) => {
        const outer = document.querySelector(`[data-bar-frame="${edge}"]`)
        const frame = outer.firstElementChild
        const pane = outer.getBoundingClientRect()
        const box = frame.getBoundingClientRect()
        const style = getComputedStyle(frame)
        const innerRight = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
        const lastRight = Math.max(...[...items(frame).children].filter((item) => item.getClientRects().length > 0).map((item) => item.getBoundingClientRect().right))
        return { scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth, insidePane: box.left >= pane.left && box.right <= pane.right + 0.5, overflowPx: Math.max(0, Math.ceil(lastRight - innerRight)) }
    }
    return { bar: fit('top', (frame) => frame.querySelector('[data-topbar]')), strip: fit('bottom', (frame) => frame) }
}

const fits = (box) => box.scrollWidth <= box.clientWidth && box.insidePane && box.overflowPx === 0
const describe = (box) => `${box.scrollWidth}/${box.clientWidth}${box.overflowPx ? ` (+${box.overflowPx} px past its padding)` : ''}${box.insidePane ? '' : ' past the pane'}`

async function check(context, base, path) {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1920, height: HEIGHT })
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('[data-topbar] [data-state-pill]', { timeout: 120_000 })
    await page.evaluate(() => document.fonts.ready)
    const results = []
    for (const pane of PANES) {
        await sizePane(page, pane)
        const { bar, strip } = await page.evaluate(measure)
        const ok = fits(bar) && fits(strip)
        results.push(ok)
        log(`${path} pane ${pane} (${tierAt(pane)}): bar ${describe(bar)}, strip ${describe(strip)} ${ok ? 'ok' : 'OVERFLOWS'}`)
    }
    await page.close()
    return results.every(Boolean)
}

async function signedInBase(context) {
    const stack = localStack()
    assertLocalProfile(stack)
    assertMigrated()
    const base = `http://localhost:${PORT}`
    const outDir = join(REPO_ROOT, '.context/verify', `factory-bar-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(outDir, { recursive: true })
    const server = await ensureServer(base, outDir)
    const account = await testAccount(stack, { fresh: false })
    await signIn(context, base, account)
    await linkTestEngine(account.admin, account.userId)
    return { base, server }
}

const options = parseArgs(process.argv.slice(2))
const browser = await chromium.launch({ executablePath: options.executablePath, args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] })
const context = await browser.newContext()
let server = null
let passed = true
try {
    let base = options.base
    if (!base) ({ base, server } = await signedInBase(context))
    for (const path of options.pages) passed = (await check(context, base, path)) && passed
} finally {
    await browser.close()
    if (server) process.kill(-server.pid)
}
log(passed ? 'The factory bar and strip fit every pane.' : 'The factory bar or strip overflows a pane.')
process.exit(passed ? 0 : 1)
