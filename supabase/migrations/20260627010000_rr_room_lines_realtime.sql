-- Enable Supabase realtime for room-order lines so the read-only Monitor tab can update
-- live (Front Office watches fulfilment status across departments). Idempotent: only adds
-- the table to the publication if it isn't already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kaizen_rr_room_lines'
  ) then
    alter publication supabase_realtime add table kaizen_rr_room_lines;
  end if;
end $$;
