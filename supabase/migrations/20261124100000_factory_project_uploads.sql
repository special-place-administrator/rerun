-- MW-PROJECTS: projects added by uploading a local folder. The browser sends the folder as one tar to
-- the hub, which stores it in the private bucket factory-uploads at <workspace_id>/<id>.tar and keeps
-- its size and sha256 on the row. The factory fetches it once through the hub with its account key,
-- unpacks it with its own walker and reports the GitHub repository it found in the folder's origin.
--
-- repo is null on an upload row until the factory has identified it. The regex check stays, nulls
-- never conflict in unique (workspace_id, repo), and a row cannot be cloning or ready without a repo.
-- upload_sha256 and upload_bytes belong to upload rows only. upload_head is the commit the folder was
-- at, or null. dropped lists, by label and path, the files the walker left out as sensitive.
--
-- The bucket is private with no policy: only the service role reads or writes it.
--
-- Rollback (where direct deletes from storage.objects are blocked, empty the bucket through the Storage API first):
--   begin;
--   delete from storage.objects where bucket_id = 'factory-uploads';
--   update public.factory_projects set error_code = 'unknown' where error_code = 'already_added';
--   delete from public.factory_projects where repo is null;
--   alter table public.factory_projects drop constraint factory_projects_error_code_check,
--       add constraint factory_projects_error_code_check check (error_code is null or error_code in (
--           'invalid_link', 'owner_not_allowed', 'not_reachable', 'quota_unset', 'quota_exceeded', 'upload_too_large', 'too_many_files',
--           'unsafe_entry', 'checksum_mismatch', 'no_github_remote', 'disk_low', 'timed_out', 'unknown'));
--   alter table public.factory_projects drop constraint factory_projects_upload_fields, drop constraint factory_projects_repo_when_working,
--       drop column dropped, drop column upload_head, drop column upload_bytes, drop column upload_sha256;
--   alter table public.factory_projects alter column repo set not null;
--   delete from storage.buckets where id = 'factory-uploads';
--   commit;
begin;

alter table public.factory_projects alter column repo drop not null;

alter table public.factory_projects
    add column upload_sha256 text check (upload_sha256 is null or upload_sha256 ~ '^[0-9a-f]{64}$'),
    add column upload_bytes bigint check (upload_bytes is null or upload_bytes >= 0),
    add column upload_head text check (upload_head is null or upload_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
    add column dropped jsonb not null default '[]' check (jsonb_typeof(dropped) = 'array' and jsonb_array_length(dropped) <= 50),
    add constraint factory_projects_repo_when_working check (state not in ('cloning', 'ready') or repo is not null),
    add constraint factory_projects_upload_fields check (source = 'upload' or (upload_sha256 is null and upload_bytes is null));

alter table public.factory_projects
    drop constraint factory_projects_error_code_check,
    add constraint factory_projects_error_code_check check (error_code is null or error_code in (
        'invalid_link', 'owner_not_allowed', 'not_reachable', 'quota_unset', 'quota_exceeded', 'upload_too_large', 'too_many_files',
        'unsafe_entry', 'checksum_mismatch', 'no_github_remote', 'disk_low', 'timed_out', 'already_added', 'unknown'
    ));

insert into storage.buckets (id, name, public) values ('factory-uploads', 'factory-uploads', false)
on conflict (id) do nothing;

commit;
