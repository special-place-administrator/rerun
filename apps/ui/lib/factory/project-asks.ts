import 'server-only'

export type ProjectAsk = { kind: 'path'; path: string; at: string; sentAt: number | null } | { kind: 'repo'; repo: string; at: string; sentAt: number | null }
export type ProjectAskAnswer = { check?: { path: string } | { repo: string; at: string }; repos?: true }

type Held = { ask: ProjectAsk | null; reposWantedAt: number | null }

const REPOS_WANTED_MS = 10 * 60_000
const store = globalThis as typeof globalThis & { __rerunFactoryProjectAsks?: Map<number, Held> }
const held = (store.__rerunFactoryProjectAsks ??= new Map<number, Held>())

const heldOf = (workspaceId: number): Held => held.get(workspaceId) ?? { ask: null, reposWantedAt: null }

export const factoryStamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function askProjectCheck(workspaceId: number, ask: ProjectAsk): void {
    held.set(workspaceId, { ...heldOf(workspaceId), ask })
}

export function currentProjectAsk(workspaceId: number): ProjectAsk | null {
    return heldOf(workspaceId).ask
}

export function clearProjectAsk(workspaceId: number): void {
    held.set(workspaceId, { ...heldOf(workspaceId), ask: null })
}

export function wantFactoryRepos(workspaceId: number, now = Date.now()): void {
    held.set(workspaceId, { ...heldOf(workspaceId), reposWantedAt: now })
}

export function takeProjectAskAnswer(workspaceId: number, now = Date.now()): ProjectAskAnswer {
    const { ask, reposWantedAt } = heldOf(workspaceId)
    if (ask && ask.sentAt === null) held.set(workspaceId, { reposWantedAt, ask: { ...ask, sentAt: now } })
    return {
        ...(ask ? { check: ask.kind === 'path' ? { path: ask.path } : { repo: ask.repo, at: ask.at } } : {}),
        ...(reposWantedAt !== null && now - reposWantedAt < REPOS_WANTED_MS ? { repos: true as const } : {}),
    }
}
