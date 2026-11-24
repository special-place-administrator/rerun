import { describe, expect, it } from 'vitest'

import { BAR_PANE_FLOOR } from '@/components/factory/factory-bar-tiers'
import {
    FACTORY_OVERLAY_BELOW,
    FACTORY_SIDE_PANEL_MIN_WIDTH,
    SIDE_PANEL_DEFAULT_WIDTH,
    SIDE_PANEL_GAP,
    SIDE_PANEL_MIN_WIDTH,
    clampSidePanelWidth,
    getSidePanelMaxWidth,
    getSidePanelMinWidth,
    parseSidePanelWidth,
} from './side-panel-width'

const keepsFloor = (viewport: number) => viewport - 18 - SIDE_PANEL_GAP - BAR_PANE_FLOOR

describe('side panel width', () => {
    it('caps its desktop maximum at 800px or 60 percent of the viewport off the factory', () => {
        expect(getSidePanelMaxWidth(1440)).toBe(800)
        expect(getSidePanelMaxWidth(1280)).toBe(768)
        expect(getSidePanelMaxWidth(1000)).toBe(600)
        expect(getSidePanelMaxWidth(500)).toBe(SIDE_PANEL_MIN_WIDTH)
    })

    it('on the factory keeps the board its pane floor down to a 360px chat, then overlays the board', () => {
        expect(getSidePanelMaxWidth(1024, true)).toBe(keepsFloor(1024))
        expect(clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, 1024, true)).toBe(keepsFloor(1024))
        expect(clampSidePanelWidth(FACTORY_SIDE_PANEL_MIN_WIDTH, 1024, true)).toBe(FACTORY_SIDE_PANEL_MIN_WIDTH)
        expect(getSidePanelMaxWidth(1280, true)).toBe(keepsFloor(1280))
        expect(clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, 1280, true)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
        expect(clampSidePanelWidth(800, 1280, true)).toBe(keepsFloor(1280))
        expect(getSidePanelMaxWidth(FACTORY_OVERLAY_BELOW, true)).toBe(FACTORY_SIDE_PANEL_MIN_WIDTH)
        expect(getSidePanelMinWidth(FACTORY_OVERLAY_BELOW - 1, true)).toBe(SIDE_PANEL_MIN_WIDTH)
        expect(getSidePanelMaxWidth(FACTORY_OVERLAY_BELOW - 1, true)).toBe(getSidePanelMaxWidth(FACTORY_OVERLAY_BELOW - 1))
        expect(clampSidePanelWidth(400, 1024)).toBe(SIDE_PANEL_MIN_WIDTH)
    })

    it('clamps widths to the supported desktop range', () => {
        expect(clampSidePanelWidth(320, 1440)).toBe(SIDE_PANEL_MIN_WIDTH)
        expect(clampSidePanelWidth(640, 1440)).toBe(640)
        expect(clampSidePanelWidth(1800, 1000)).toBe(600)
    })

    it('falls back to the default for missing or invalid stored values', () => {
        expect(parseSidePanelWidth(null, 1440)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
        expect(parseSidePanelWidth('', 1440)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
        expect(parseSidePanelWidth('not-a-number', 1440)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
    })

    it('restores valid values and clamps stale out-of-range values', () => {
        expect(parseSidePanelWidth('720', 1440)).toBe(720)
        expect(parseSidePanelWidth('200', 1440)).toBe(SIDE_PANEL_MIN_WIDTH)
        expect(parseSidePanelWidth('2000', 1000)).toBe(600)
    })
})
