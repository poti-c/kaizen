-- Routine Roster monitor board: stream order changes to the read-only wall display.
--
-- The room-order monitor already works because kaizen_rr_room_lines is in the
-- supabase_realtime publication. The Today-board monitor subscribes to the
-- routine orders instead, so those two tables need the same treatment —
-- without this the board renders once and then never updates.
--
-- RLS stays in force: realtime applies row-level security to postgres_changes,
-- so a subscriber only receives rows it could already SELECT.

alter publication supabase_realtime add table public.kaizen_rr_orders;
alter publication supabase_realtime add table public.kaizen_rr_order_items;
