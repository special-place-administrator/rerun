create function public.advance_factory_control_request_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if old.state_at is not null and new.state_at is not null then
        new.state_at := greatest(new.state_at, date_trunc('milliseconds', old.state_at) + interval '1 millisecond');
    end if;
    return new;
end;
$$;

create trigger advance_factory_control_request_time
before update of state, state_at on public.factory_controls
for each row execute function public.advance_factory_control_request_time();
