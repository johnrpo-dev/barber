-- Sprint 8, parte C: avisos al dueño por correo (docs/sprint-8-gastos-controles.md §3).
-- 1. owner_alerts: una fila por evento que el dueño debe saber (UNIQUE location_id, kind, ref_id).
--    kind: void_requested (solicitud de anulación pendiente), cash_review (cierre de caja que la base
--    marcó para revisión con el umbral de la sede, needs_review u opening_needs_review), day_reopened
--    (reapertura de un día contable) y courtesy (cortesía). ref_id es el id de la fila de origen. La
--    llena un barrido del worker cada minuto (INSERT … SELECT … ON CONFLICT DO NOTHING sobre los
--    últimos 2 días, src/db/owner-alerts.ts): NO hay triggers en las tablas del dinero, ni cambios en
--    cash.ts o voids.ts. Repetir el barrido no duplica.
-- 2. Permisos: villa_app recibe SELECT e INSERT (el default de app_apply_grants) y UPDATE SOLO de
--    notified_at, para marcar el aviso cuando el correo salió. Un trigger exige que notified_at pase
--    de null a una fecha una sola vez y que nada más cambie: un aviso entregado no se puede "desmarcar"
--    para que salga otra vez. Sin DELETE: los avisos no se purgan (unas pocas filas al día; borrar uno
--    que aún cae en la ventana de 2 días del barrido lo haría renacer y salir otra vez).
-- app_apply_grants parte de la última definición (0025) y solo agrega la línea de owner_alerts.
CREATE TABLE "owner_alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "owner_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "owner_alerts_ref_key" UNIQUE("location_id","kind","ref_id"),
	CONSTRAINT "owner_alerts_kind_check" CHECK ("owner_alerts"."kind" in ('void_requested','cash_review','day_reopened','courtesy'))
);
--> statement-breakpoint
ALTER TABLE "owner_alerts" ADD CONSTRAINT "owner_alerts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_alerts_pending_idx" ON "owner_alerts" USING btree ("location_id","id") WHERE "owner_alerts"."notified_at" is null;
--> statement-breakpoint
CREATE FUNCTION owner_alerts_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.notified_at IS NULL AND NEW.notified_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.location_id = OLD.location_id AND NEW.kind = OLD.kind
     AND NEW.ref_id = OLD.ref_id AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'aviso al dueño %: solo se marca como entregado, y una sola vez', OLD.id USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_alerts_before_update BEFORE UPDATE ON owner_alerts
  FOR EACH ROW EXECUTE FUNCTION owner_alerts_before_update();
--> statement-breakpoint
CREATE TRIGGER owner_alerts_no_truncate BEFORE TRUNCATE ON owner_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_apply_grants() RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_app') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM villa_app';
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM villa_app';
  EXECUTE 'GRANT USAGE ON SCHEMA public TO villa_app';
  -- Lo mínimo para todas: leer e insertar. Una tabla nueva nace solo-inserción para la app.
  EXECUTE 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO villa_app';
  EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO villa_app';
  -- UPDATE solo donde la app modifica filas (y los triggers de cada tabla acotan qué cambia).
  -- NO están: accounts, journal_entries, journal_lines, day_close_events, appointment_events,
  -- client_consents, notifications, notification_events, sale_lines, sale_payments, sale_tips,
  -- cash_movements, expenses, personal_data_reads, audit_events.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- Dispositivos recordados: solo marcar el último uso y revocar.
  FOREACH t IN ARRAY ARRAY['client_devices'] LOOP
    EXECUTE format('GRANT UPDATE (last_used_at, revoked_at) ON %I TO villa_app', t);
  END LOOP;
  -- Solo las columnas que cambian: editar un medio de pago o una categoría, anular una venta,
  -- cerrar un turno y darlo por revisado, decidir una solicitud, marcar un aviso como entregado,
  -- revertir una liquidación (y sus líneas) o un anticipo.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash, reviewed_by) ON cash_sessions TO villa_app';
  EXECUTE 'GRANT UPDATE (status, decided_by, decided_at, decision_note, decision_idempotency_key, decision_request_hash)
    ON void_requests TO villa_app';
  EXECUTE 'GRANT UPDATE (notified_at, occurrences, failures, locked_until) ON security_alerts TO villa_app';
  -- Avisos al dueño (0027): solo marcar que el correo salió (el trigger exige null → fecha, una vez).
  EXECUTE 'GRANT UPDATE (notified_at) ON owner_alerts TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON commission_settlements TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON staff_advances TO villa_app';
  EXECUTE 'GRANT UPDATE (reversed) ON commission_settlement_lines TO villa_app';
  -- DELETE solo en lo efímero: sesiones y verificaciones de better-auth, el horario semanal
  -- (se reemplaza completo), los servicios de cada persona (se quitan al desmarcarlos), los contadores de límites, los avisos de seguridad ya entregados
  -- y los navegadores recordados que dejaron de servir hace más de 30 días (0025: un trigger lo exige fila por fila).
  -- owner_alerts NO está: los avisos al dueño no se borran (0027).
  FOREACH t IN ARRAY ARRAY[
    'session', 'verification', 'two_factor', 'staff_schedules', 'staff_services', 'rate_limit_counters',
    'login_throttles', 'security_alerts', 'client_devices'
  ] LOOP
    EXECUTE format('GRANT DELETE ON %I TO villa_app', t);
  END LOOP;
  -- La purga de datos personales: la llama el mantenimiento diario del worker (rol villa_app).
  EXECUTE 'REVOKE ALL ON FUNCTION purge_expired_personal_data() FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION purge_expired_personal_data() TO villa_app';
  -- La supresión a solicitud del titular: la llama la acción del dueño; la app no tiene UPDATE propio
  -- sobre esas columnas.
  EXECUTE 'REVOKE ALL ON FUNCTION erase_client_personal_data(bigint, bigint) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION erase_client_personal_data(bigint, bigint) TO villa_app';
END;
$$;
--> statement-breakpoint
SELECT app_apply_grants();
