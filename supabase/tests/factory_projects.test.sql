-- RLS of factory_projects (migration 20261123120000_factory_projects): members read their workspace's
-- projects, nobody writes one with a browser token, not even an admin. Runs with
-- `pnpm exec supabase test db` on the local stack; everything is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path to public, extensions;

select plan(6);

insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-00000000f001', 'fp-admin@rerun.test'),
    ('00000000-0000-0000-0000-00000000f002', 'fp-member@rerun.test'),
    ('00000000-0000-0000-0000-00000000f003', 'fp-outsider@rerun.test');
insert into public.workspaces (id, icon_url, name) values (990101, '', 'Factory projects'), (990102, '', 'Other');
insert into public.users (id, workspace_id) values
    ('00000000-0000-0000-0000-00000000f001', 990101),
    ('00000000-0000-0000-0000-00000000f002', 990101),
    ('00000000-0000-0000-0000-00000000f003', 990102)
on conflict (id) do update set workspace_id = excluded.workspace_id;
insert into public.workspace_members (user_id, workspace_id, role, box_scope) values
    ('00000000-0000-0000-0000-00000000f001', 990101, 'admin', 'all'),
    ('00000000-0000-0000-0000-00000000f002', 990101, 'member', 'all'),
    ('00000000-0000-0000-0000-00000000f003', 990102, 'admin', 'all');
insert into public.factory_projects (workspace_id, repo, active) values (990101, 'acme/app', true), (990101, 'acme/site', false);

create function pg_temp.act_as(uid uuid) returns void language sql as $$
    select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000f002');
select is((select count(*)::int from public.factory_projects where workspace_id = 990101), 2, 'a member reads the projects of their workspace');

select pg_temp.act_as('00000000-0000-0000-0000-00000000f003');
select is((select count(*)::int from public.factory_projects), 0, 'a member of another workspace reads none');

select pg_temp.act_as('00000000-0000-0000-0000-00000000f001');
select throws_ok($$ insert into public.factory_projects (workspace_id, repo) values (990101, 'acme/sneaky') $$, '42501', null, 'an admin cannot add a project with a browser token');
select throws_ok($$ update public.factory_projects set active = true where repo = 'acme/site' $$, '42501', null, 'an admin cannot select a project with a browser token');
select throws_ok($$ delete from public.factory_projects where repo = 'acme/site' $$, '42501', null, 'an admin cannot remove a project with a browser token');

reset role;
select throws_ok($$ insert into public.factory_projects (workspace_id, repo, active) values (990101, 'acme/third', true) $$, '23505', null, 'a workspace has at most one active project');

select * from finish();
rollback;
