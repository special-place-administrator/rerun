import { scanTextForSecrets } from '@moldwright/contracts'
import { env } from '../config/env.js'

const KNOWN_SECRET_LABEL = 'Known secret value'
export const SECRET_CHECK_UNAVAILABLE = 'Secret check unavailable'
const MIN_SECRET_LENGTH = 8

const heldHubTokens = new Set<string>()

export function holdHubToken(token: string | undefined): void {
    if (token && token.length >= MIN_SECRET_LENGTH) heldHubTokens.add(token)
}

export function secretLabels(texts: readonly string[], senderSecrets: () => readonly string[]): string[] {
    try {
        const exact = [...senderSecrets(), env().RERUN_API_KEY ?? '', ...heldHubTokens].filter(value => value.length >= MIN_SECRET_LENGTH)
        const labels = new Set<string>()
        for (const text of texts) {
            for (const label of scanTextForSecrets(text)) labels.add(label)
            if (exact.some(value => text.includes(value))) labels.add(KNOWN_SECRET_LABEL)
        }
        return [...labels]
    } catch {
        return [SECRET_CHECK_UNAVAILABLE]
    }
}
