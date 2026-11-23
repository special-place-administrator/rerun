-- MW-ACCESS-R1: a browser token can no longer move a coworker to another Box. A cross-Box move
-- goes through moveAgentToBox on the server (service_role), which checks both Boxes and switches
-- team tools off when the mover cannot enable them in the target Box. The update policy cannot
-- hold this line by itself: its check sees only the new row, so it cannot tell a move from an edit.
--
-- `revoke update (space_id)` alone changes nothing while UPDATE is granted on the whole table, so
-- the table-wide grant is taken back and UPDATE is handed out column by column. id, workspace_id,
-- space_id and created_at are left out, and so are engine_agent_id and template_id: they bind the row
-- to an engine agent and a template, and only the server sets them. anon gets no UPDATE back: it
-- is never a workspace member.
--
-- Fails closed: a column added to agents later is NOT writable with a browser token until its own
-- migration grants UPDATE on it to authenticated.
--
-- Rollback:
--   grant update on public.agents to authenticated;
begin;

revoke update on table public.agents from anon, authenticated;

grant update (
    name,
    description,
    status,
    col,
    "row",
    handle,
    disabled_at,
    disabled_reason,
    disabled_schedule_slugs
) on table public.agents to authenticated;

commit;
