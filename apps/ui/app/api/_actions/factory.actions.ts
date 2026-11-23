'use server'

import type { FactorySnapshot } from '@moldwright/contracts'
import { requireWorkspaceContext, requireWorkspaceId } from '@/app/api/_auth/ownership'
import { actOnWorkOrder, cancelWorkOrder, createWorkOrder, readFactoryControls, setFactoryState, setProviderEnabled, type FactoryControlsView, type FactoryWorkOrder, type WorkOrderAction, type WorkOrderInput } from '@/app/api/_services/factory-controls.service'
import { addPathProject, addRepoProject, listFactoryProjects, removeProject, selectProject, type FactoryProject, type PathOutcome, type SelectOutcome } from '@/app/api/_services/factory-projects.service'
import { getFactorySnapshot } from '@/lib/factory/snapshot-store'
import { failureOf } from '@/lib/i18n/action-error'
import type { ActionResult } from './space.actions'

export async function listFactoryProjectsAction(wantRepos: boolean): Promise<ActionResult<{ projects: FactoryProject[]; isOwner: boolean }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, ...await listFactoryProjects(workspace.id, userId, wantRepos === true) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function addFactoryRepoAction(repo: string): Promise<ActionResult<{ project: FactoryProject }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, project: await addRepoProject(workspace.id, userId, String(repo)) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function addFactoryPathAction(path: string): Promise<ActionResult<{ outcome: PathOutcome }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, outcome: await addPathProject(workspace.id, userId, String(path)) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function selectFactoryProjectAction(id: number): Promise<ActionResult<{ outcome: SelectOutcome }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, outcome: await selectProject(workspace.id, userId, Number(id)) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function removeFactoryProjectAction(id: number): Promise<ActionResult> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        await removeProject(workspace.id, userId, Number(id))
        return { ok: true }
    } catch (err) {
        return failureOf(err)
    }
}

export async function readFactoryControlsAction(): Promise<ActionResult<{ controls: FactoryControlsView }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, controls: await readFactoryControls(workspace.id, userId) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function setFactoryStateAction(state: string): Promise<ActionResult> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        await setFactoryState(workspace.id, userId, String(state))
        return { ok: true }
    } catch (err) {
        return failureOf(err)
    }
}

export async function setFactoryProviderAction(connectionId: string, enabled: boolean): Promise<ActionResult<{ off: string[] }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, off: await setProviderEnabled(workspace.id, userId, String(connectionId), enabled === true) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function createFactoryWorkOrderAction(input: WorkOrderInput): Promise<ActionResult<{ order: FactoryWorkOrder }>> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        return { ok: true, order: await createWorkOrder(workspace.id, userId, input) }
    } catch (err) {
        return failureOf(err)
    }
}

export async function cancelFactoryWorkOrderAction(id: string): Promise<ActionResult> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        await cancelWorkOrder(workspace.id, userId, String(id))
        return { ok: true }
    } catch (err) {
        return failureOf(err)
    }
}

export async function actOnFactoryWorkOrderAction(id: string, action: WorkOrderAction, issue: number): Promise<ActionResult> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        await actOnWorkOrder(workspace.id, userId, String(id), action, Number(issue))
        return { ok: true }
    } catch (err) {
        return failureOf(err)
    }
}

export async function readFactorySnapshotAction(): Promise<{ snapshot: FactorySnapshot; receivedAt: number; ageMs: number } | null> {
    const workspaceId = await requireWorkspaceId()
    const held = getFactorySnapshot(workspaceId)
    if (!held) return null
    return { snapshot: held.snapshot, receivedAt: held.receivedAt, ageMs: Date.now() - held.receivedAt }
}
