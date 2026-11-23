-- Revoke TRUNCATE, TRIGGER, and REFERENCES on all tables in public from unprivileged roles (anon, authenticated).
-- PostgreSQL TRUNCATE completely bypasses Row Level Security.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- Revoke write privileges on tables managed exclusively by service_role or server-side actions.
revoke delete, insert, update on table
    public.api_keys,
    public.blocked_email_domains,
    public.blog_posts,
    public.connector_requests,
    public.engine_box_metrics,
    public.engine_host_metrics,
    public.engine_hosts,
    public.engine_pool,
    public.expert_email_opt_outs,
    public.expert_hire_requests,
    public.invitation_codes,
    public.invitation_redemptions,
    public.published_files,
    public.rerun_usage_events,
    public.workspace_invitations,
    public.workspace_members,
    public.workspaces
from anon, authenticated;

-- Revoke SELECT on internal machine and secret tables from unprivileged roles.
revoke select on table
    public.api_keys,
    public.engine_box_metrics,
    public.engine_host_metrics,
    public.engine_hosts,
    public.engine_pool
from anon, authenticated;

-- Revoke public execution of credit management functions from PUBLIC, anon, and authenticated.
revoke all on function public.consume_rerun_credit(bigint, bigint) from public, anon, authenticated;
revoke all on function public.grant_rerun_topup(bigint, bigint) from public, anon, authenticated;
grant execute on function public.consume_rerun_credit(bigint, bigint) to service_role;
grant execute on function public.grant_rerun_topup(bigint, bigint) to service_role;

-- Ensure current_workspace_ids() cannot be called by unauthenticated callers.
revoke all on function public.current_workspace_ids() from public, anon;
