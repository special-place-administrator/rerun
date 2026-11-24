import { isFactoryReporter, takeUploadArchive } from '@/app/api/_services/factory-projects.service'
import { bearerToken, keyActor } from '@/lib/mcp/account-rpc'
import { authenticateApiKey } from '@/lib/mcp/api-keys'
import { isImportKey } from '@/lib/mcp/import-scope'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROJECT_ID = /^[1-9][0-9]{0,15}$/

const refused = (code: string, status: number) => Response.json({ error: { code } }, { status })

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const key = await authenticateApiKey(bearerToken(req))
    if (!key || isImportKey(key)) return refused('unauthenticated', 401)
    const actor = await keyActor(key)
    if (!actor || !(await isFactoryReporter(actor).catch(() => false))) return refused('forbidden', 403)
    const { id } = await params
    const projectId = PROJECT_ID.test(id) ? Number(id) : NaN
    if (!Number.isSafeInteger(projectId)) return refused('not_found', 404)
    try {
        const archive = await takeUploadArchive(actor.workspaceId, projectId)
        if (!archive) return refused('already_fetched', 409)
        return new Response(archive, { headers: { 'content-type': 'application/x-tar', 'cache-control': 'no-store' } })
    } catch {
        return refused('unknown', 500)
    }
}
