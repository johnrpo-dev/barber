-- Garantías del horario del personal, escritas a mano (drizzle-kit no genera EXCLUDE).
-- La validación de dominio (src/domain/staff/schedule.ts) ya rechaza solapamientos;
-- esto es la última barrera para cualquier escritura que no pase por ella.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Dos bloques del mismo barbero el mismo día no pueden cruzarse. Los que se tocan
-- (09:00–14:00 y 14:00–19:00) sí se permiten porque int4range es semiabierto [inicio, fin).
ALTER TABLE staff_schedules
  ADD CONSTRAINT staff_schedules_no_overlap
  EXCLUDE USING gist (staff_id WITH =, weekday WITH =, int4range(start_min, end_min) WITH &&);
--> statement-breakpoint

CREATE INDEX staff_schedules_staff_idx ON staff_schedules (location_id, staff_id, weekday);
