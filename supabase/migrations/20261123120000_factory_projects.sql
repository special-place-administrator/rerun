-- MW-FACTORY-FOCUS: the projects a workspace's factory may work on, and the one it works on now.
-- A row is a GitHub repository the factory can reach, or a git folder on the factory host (host_path,
-- as the factory resolved it) mapped to its GitHub origin. Every write is the server's, on
-- service_role, after the workspace owner check (factory-projects.service.ts): no browser token
-- inserts, updates or deletes a row. Members of the workspace read its rows.
--
-- active marks the selected project, at most one per workspace. activated_at is the moment the owner
-- asked for it; the factory_report answer sends it unchanged, so the factory takes a readiness check
-- newer than that moment and never re-runs it on each beat.
--
-- Rollback:
--   drop table public.factory_projects;
begin;

create table public.factory_projects (
    id bigint generated always as identity primary key,
    workspace_id bigint not null references public.workspaces (id) on delete cascade,
    repo text not null check (repo ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_.-]{1,100}$'),
    host_path text check (host_path is null or char_length(host_path) between 1 and 4096),
    active boolean not null default false,
    activated_at timestamptz,
    activated_by uuid references auth.users (id) on delete set null,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (workspace_id, repo)
);

create unique index factory_projects_one_active on public.factory_projects (workspace_id) where active;

alter table public.factory_projects enable row level security;

create policy factory_projects_select_workspace_members on public.factory_projects for select to authenticated
    using (workspace_id in (select public.current_workspace_ids()));

revoke all on table public.factory_projects from anon, authenticated;
grant select on table public.factory_projects to authenticated;

commit;
