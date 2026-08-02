-- Grant the restaurant department the read-only Routine Roster monitor tab.
--
-- Applied to live on 2026-08-02 as a stopgap: the restaurant (FB) could see
-- only the aggregate room count on an order card, never the room number, so
-- staff did not know where to deliver. The monitor tab's detail modal does
-- show room_no, and `rr_monitor_depts` is the grant that opens that tab to a
-- department beyond front office / management (see RoutineRosterPage
-- `canMonitor` and the RoomMonitorAccessSettings component).
--
-- The card itself now renders the room numbers directly, so this grant is a
-- convenience rather than the fix. It is safe to remove from Settings ->
-- "Monitor tab access" once the frontend change has reached every device;
-- doing so through the UI will not be undone by this migration, which only
-- ever seeds a company that has no value set yet.
--
-- Idempotent and a no-op against live: ON CONFLICT DO NOTHING leaves any
-- existing row (including an operator's later edit) exactly as it is.

INSERT INTO kaizen_settings (company_id, key, value)
VALUES ('a0000000-0000-0000-0000-000000000001', 'rr_monitor_depts', '["restaurant"]'::jsonb)
ON CONFLICT ON CONSTRAINT kaizen_settings_key_company_key DO NOTHING;
