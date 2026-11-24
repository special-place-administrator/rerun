-- MW-PROJECTS: projects the factory keeps in its own area, added by GitHub link (and, next, by upload).
-- source says how a project came in. state is where the factory is with it: a new row is queued, and
-- only the factory's own reports move it on (factory-projects.service.ts applyFactoryProjectItems).
-- error_code is set exactly when state is failed, from a fixed list: never free text, a path or git
-- output. progress_done/progress_total are both set or both null. name is what the dropdown shows,
-- server-derived; existing rows take the repo part of repo. Existing rows, host_path ones included,
-- become source github, state ready. host_path stays readable by the server for one release.
--
-- factory_controls.project_limits holds the owner's project quota (factoryProjectLimitsSchema). Null
-- means no quota is set, and every add is refused.
--
-- RLS is unchanged: members read, every write is the server's on service_role.
--
-- Rollback:
--   alter table public.factory_controls drop column project_limits_at, drop column project_limits_by, drop column project_limits;
--   alter table public.factory_projects drop constraint factory_projects_failed_has_code, drop constraint factory_projects_progress,
--       drop constraint factory_projects_name_length, drop column updated_at, drop column name, drop column progress_total,
--       drop column progress_done, drop column error_code, drop column state, drop column source;
begin;

alter table public.factory_projects
    add column source text not null default 'github' check (source in ('github', 'upload')),
    add column state text not null default 'ready' check (state in ('queued', 'uploading', 'cloning', 'unpacking', 'checking', 'ready', 'failed')),
    add column error_code text check (error_code is null or error_code in (
        'invalid_link', 'owner_not_allowed', 'not_reachable', 'quota_unset', 'quota_exceeded', 'upload_too_large', 'too_many_files',
        'unsafe_entry', 'checksum_mismatch', 'no_github_remote', 'disk_low', 'timed_out', 'unknown'
    )),
    add column progress_done bigint,
    add column progress_total bigint,
    add column name text,
    add column updated_at timestamptz not null default now();

alter table public.factory_projects alter column state set default 'queued';

update public.factory_projects set name = split_part(repo, '/', 2);

alter table public.factory_projects
    alter column name set not null,
    add constraint factory_projects_name_length check (char_length(name) between 1 and 100),
    add constraint factory_projects_progress check (
        (progress_done is null) = (progress_total is null)
        and (progress_done is null or progress_done between 0 and progress_total)
    ),
    add constraint factory_projects_failed_has_code check ((state = 'failed') = (error_code is not null));

alter table public.factory_controls
    add column project_limits jsonb check (project_limits is null or jsonb_typeof(project_limits) = 'object'),
    add column project_limits_by uuid references auth.users (id) on delete set null,
    add column project_limits_at timestamptz;

commit;
