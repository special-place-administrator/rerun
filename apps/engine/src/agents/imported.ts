import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { importedMarkerPath } from '../config/paths.js'

export async function markImported(id: string): Promise<void> {
    await mkdir(dirname(importedMarkerPath(id)), { recursive: true })
    await writeFile(importedMarkerPath(id), '', 'utf8')
}

export const isImported = (id: string): boolean => existsSync(importedMarkerPath(id))
