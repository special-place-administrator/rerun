import { trustRefusal } from '../agents/everos-allowlist.js'
import { agentSecretValues } from '../agents/shared-env.js'
import { HttpError } from '../lib/errors.js'
import type { RunContext } from '../runtime/context.js'
import { agentAddress } from './address.js'

export type BusSender = {
    address: string
    runId?: string
    pending: boolean
    untrusted: boolean
    secrets: () => readonly string[]
}

export const DELEGATE_HAS_NO_BUS = 'a delegate has no message bus: report back to the agent that delegated the task'

export async function agentSender(ctx: Pick<RunContext, 'agent' | 'runId' | 'lineage' | 'taintedByUntrustedInput'>): Promise<BusSender> {
    const { agent } = ctx
    if (agent.hubAgentId) throw new HttpError(403, DELEGATE_HAS_NO_BUS, 'bus_delegate')
    const pending = (await trustRefusal(agent)) !== null
    return {
        address: agentAddress(agent.id, ctx.lineage?.copyIndex),
        runId: ctx.runId,
        pending,
        untrusted: pending || ctx.taintedByUntrustedInput === true,
        secrets: () => [...agentSecretValues(agent), ...(agent.brief?.hubToken ? [agent.brief.hubToken] : [])],
    }
}
