import { describe, expect, it } from 'vitest'

import { projectLook } from './ProjectMark'

describe('projectLook', () => {
    it('gives a repo the same colour and initial every time, whatever the case', () => {
        expect(projectLook('Acme/App')).toEqual(projectLook('acme/app'))
        expect(projectLook('acme/app').initial).toBe('A')
        expect(projectLook('acme/.site').initial).toBe('S')
        expect(projectLook('acme/web').color).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('spreads repositories over several colours', () => {
        const colours = new Set(['acme/app', 'acme/site', 'acme/api', 'acme/docs', 'acme/web', 'acme/cli'].map(r => projectLook(r).color))
        expect(colours.size).toBeGreaterThan(1)
    })
})
