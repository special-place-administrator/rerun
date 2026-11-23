import { assertAgentInWorkspace, assertCanEnableTeamTools, isAdminActor, AccessDeniedError, type Actor } from '@/app/api/_auth/access'
import { getAgent as engineGetAgent } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { FOREMAN_AGENT_ID } from '@moldwright/contracts'

export async function assertTeamToolsSwitch(actor: Actor, agentId: string, conn: EngineConnection, engineAgentId: string, tools: Record<string, boolean> | undefined): Promise<void> {
    if (tools?.team !== true) return
    const { config } = await engineGetAgent(conn, engineAgentId)
    if (config.tools.team === true) return
    if (agentId === FOREMAN_AGENT_ID) {
        if (!isAdminActor(actor)) throw new AccessDeniedError()
        return
    }
    const { space_id } = await assertAgentInWorkspace(agentId, 'manage', actor)
    await assertCanEnableTeamTools(actor, space_id)
}
