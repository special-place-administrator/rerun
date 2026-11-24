import { BAR_PANE_FLOOR } from '@/components/factory/factory-bar-tiers'
import type { SheetDetent } from '@/components/layout/useSheetResize'

export const SIDE_PANEL_DEFAULT_WIDTH = 640
export const SIDE_PANEL_MIN_WIDTH = 480
export const SIDE_PANEL_MAX_WIDTH = 800
export const SIDE_PANEL_MAX_VIEWPORT_RATIO = 0.6
export const SIDE_PANEL_GAP = 8
const BOARD_FRAME_WIDTH = 18

export const SIDE_PANEL_WIDTH_STORAGE_KEY = 'rerun-agent-panel-width'

export const FACTORY_SIDE_PANEL_MIN_WIDTH = 360
export const FACTORY_OVERLAY_BELOW = BAR_PANE_FLOOR + FACTORY_SIDE_PANEL_MIN_WIDTH + SIDE_PANEL_GAP + BOARD_FRAME_WIDTH

const besideFactory = (viewportWidth: number, factory: boolean) => factory && viewportWidth >= FACTORY_OVERLAY_BELOW

export function getSidePanelMinWidth(viewportWidth: number, factory = false): number {
    return besideFactory(viewportWidth, factory) ? FACTORY_SIDE_PANEL_MIN_WIDTH : SIDE_PANEL_MIN_WIDTH
}

export function getSidePanelMaxWidth(viewportWidth: number, factory = false): number {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDE_PANEL_DEFAULT_WIDTH
    const fitsViewport = Math.min(SIDE_PANEL_MAX_WIDTH, Math.floor(viewportWidth * SIDE_PANEL_MAX_VIEWPORT_RATIO))
    if (besideFactory(viewportWidth, factory)) return Math.min(fitsViewport, viewportWidth - BOARD_FRAME_WIDTH - SIDE_PANEL_GAP - BAR_PANE_FLOOR)
    return Math.max(SIDE_PANEL_MIN_WIDTH, fitsViewport)
}

export function clampSidePanelWidth(width: number, viewportWidth: number, factory = false): number {
    const safeWidth = Number.isFinite(width) ? Math.round(width) : SIDE_PANEL_DEFAULT_WIDTH
    return Math.min(Math.max(safeWidth, getSidePanelMinWidth(viewportWidth, factory)), getSidePanelMaxWidth(viewportWidth, factory))
}

export function parseSidePanelWidth(value: string | null, viewportWidth: number, factory = false): number {
    if (value === null || value.trim() === '') return clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, viewportWidth, factory)

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, viewportWidth, factory)

    return clampSidePanelWidth(parsed, viewportWidth, factory)
}

export function loadSidePanelWidth(viewportWidth: number, factory = false): number {
    try {
        return parseSidePanelWidth(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY), viewportWidth, factory)
    } catch {
        return clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, viewportWidth, factory)
    }
}

export function saveSidePanelWidth(width: number, viewportWidth: number, factory = false): number {
    const clamped = clampSidePanelWidth(width, viewportWidth, factory)
    try {
        localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(clamped))
    } catch {}
    return clamped
}

export const SIDE_PANEL_SHEET_DETENT_STORAGE_KEY = 'rerun:agent-sheet-detent'

export function loadSidePanelSheetDetent(): SheetDetent {
    try {
        return localStorage.getItem(SIDE_PANEL_SHEET_DETENT_STORAGE_KEY) === 'medium' ? 'medium' : 'large'
    } catch {
        return 'large'
    }
}

export function rememberSidePanelSheetDetent(detent: SheetDetent): void {
    try {
        localStorage.setItem(SIDE_PANEL_SHEET_DETENT_STORAGE_KEY, detent)
    } catch {}
}
