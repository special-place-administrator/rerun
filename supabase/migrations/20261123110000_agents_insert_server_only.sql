-- MW-ACCESS-R1: a browser token can no longer create a coworker row. Every insert into agents is
-- the server's (agent.service.ts, on service_role), which binds the row to the engine agent it has
-- just created. With INSERT granted to authenticated, a Box manager could insert a row whose
-- engine_agent_id names the foreman or another workspace's engine agent, and then drive that agent
-- through update_agent or chat: the insert policy checks the workspace and the Box, not the binding.
--
-- No INSERT is re-granted column by column: there is no browser writer. The insert policy stays as
-- a backstop for any role that is granted INSERT later.
--
-- Rollback:
--   grant insert on public.agents to anon, authenticated;
begin;

revoke insert on table public.agents from anon, authenticated;

commit;
