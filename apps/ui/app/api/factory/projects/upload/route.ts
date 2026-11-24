import { AuthorizationError, UnauthenticatedError } from '@/app/api/_auth/errors'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { uploadProject, type UploadRefusal } from '@/app/api/_services/factory-projects.service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteRefusal = UploadRefusal | 'unauthenticated' | 'owner_only'

const STATUS: Record<RouteRefusal, number> = {
    unauthenticated: 401,
    owner_only: 403,
    quota_unset: 409,
    quota_exceeded: 409,
    length_required: 411,
    upload_too_large: 413,
    unknown: 500,
}

const refused = (code: RouteRefusal) => Response.json({ error: { code } }, { status: STATUS[code] })

export async function POST(req: Request): Promise<Response> {
    try {
        const { workspace, userId } = await requireWorkspaceContext()
        const outcome = await uploadProject(workspace.id, userId, {
            name: new URL(req.url).searchParams.get('name'),
            length: req.headers.get('content-length'),
            body: req.body,
        })
        return 'project' in outcome ? Response.json({ project: outcome.project }) : refused(outcome.code)
    } catch (err) {
        if (err instanceof UnauthenticatedError) return refused('unauthenticated')
        if (err instanceof AuthorizationError) return refused('owner_only')
        return refused('unknown')
    }
}
