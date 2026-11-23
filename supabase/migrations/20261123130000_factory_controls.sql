-- MW-FACTORY-CONTROLS: the owner's controls over a workspace's factory, sent to the dispatcher in the
-- factory_report answer (factory-controls.service.ts). Every write is the server's, on service_role,
-- after the workspace owner check: no browser token inserts, updates or deletes a row. Members of the
-- workspace read them.
--
-- factory_controls: one row per workspace, made on the owner's first change. No row means nothing is
-- sent, and the dispatcher keeps its own default (PAUSED, every connection on). state_at is the click:
-- the dispatcher applies each distinct (state, by, at) once, so every click stores a new one.
-- providers_at stays null until the owner first toggles a connection.
--
-- factory_work_orders: what the owner asked the factory to do in one project. At most one active
-- order per project; id is the order id on the wire. A stop or the owner's cancel sets status
-- cancelled. action is the owner's last retry or skip of the order's halted job.
--
-- Rollback:
--   drop table public.factory_work_orders;
--   drop table public.factory_controls;
begin;

create table public.factory_controls (
    workspace_id bigint primary key references public.workspaces (id) on delete cascade,
    state text check (state in ('RUNNING', 'PAUSED', 'DRAINING', 'STOPPED')),
    state_by uuid references auth.users (id) on delete set null,
    state_at timestamptz,
    providers_off text[] not null default '{}' check (cardinality(providers_off) <= 50),
    providers_by uuid references auth.users (id) on delete set null,
    providers_at timestamptz,
    check ((state is null) = (state_at is null))
);

alter table public.factory_controls enable row level security;

create policy factory_controls_select_workspace_members on public.factory_controls for select to authenticated
    using (workspace_id in (select public.current_workspace_ids()));

revoke all on table public.factory_controls from anon, authenticated;
grant select on table public.factory_controls to authenticated;

create table public.factory_work_orders (
    id text primary key check (id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    workspace_id bigint not null references public.workspaces (id) on delete cascade,
    repo text not null check (repo ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_.-]{1,100}$'),
    kind text not null check (kind in ('issue', 'all_issues', 'feature', 'bug')),
    issues integer[] not null default '{}' check (cardinality(issues) <= 200),
    text text not null default '' check (char_length(text) <= 4000),
    status text not null default 'active' check (status in ('active', 'cancelled')),
    action jsonb,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    cancelled_by uuid references auth.users (id) on delete set null,
    cancelled_at timestamptz
);

create unique index factory_work_orders_one_active on public.factory_work_orders (workspace_id, repo) where status = 'active';
create index factory_work_orders_workspace on public.factory_work_orders (workspace_id, created_at desc);

alter table public.factory_work_orders enable row level security;

create policy factory_work_orders_select_workspace_members on public.factory_work_orders for select to authenticated
    using (workspace_id in (select public.current_workspace_ids()));

revoke all on table public.factory_work_orders from anon, authenticated;
grant select on table public.factory_work_orders to authenticated;

commit;
