-- 026: keep the maintenance room-location view tenant-safe.
--
-- Migration 025 introduced maintenance.guest_room_locations over hotel.rooms.
-- A plain view runs with the privileges of its owner, which would bypass the
-- row-level security policies on hotel.rooms. security_invoker makes the view
-- execute as the querying role, so RLS and grants still apply. verify-db.mjs
-- asserts that no application view bypasses RLS.

DROP VIEW IF EXISTS maintenance.guest_room_locations;

CREATE VIEW maintenance.guest_room_locations
WITH (security_invoker = true) AS
SELECT r.tenant_id,
       r.hotel_id,
       r.id AS room_id,
       r.room_number AS location_code,
       ('Room ' || r.room_number) AS location_name,
       'guest_room'::text AS category,
       r.floor_label,
       r.housekeeping_status,
       r.is_out_of_order
FROM hotel.rooms r;

GRANT SELECT ON maintenance.guest_room_locations TO hospitality_app;
