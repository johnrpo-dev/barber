-- Resultados de los respaldos (sprint 9). Problema que resuelve: si el backup diario deja de correr o
-- falla, hoy solo queda una línea en el journal del VPS (y un webhook, si se configuró). El dueño no
-- lo ve. Ahora Inicio dice "Último respaldo: hoy 3:10" o avisa que falló (src/domain/ops/backup-status.ts).
-- 1. backup_runs: una fila por corrida (backup diario o prueba de restauración), buena o mala, con la
--    hora en UTC, el tamaño del archivo cifrado y una nota corta. Sin datos personales ni secretos.
--    Infraestructura, como worker_heartbeats (0030): sin location_id, un backup es de toda la base.
-- 2. La escriben deploy/backup/villa-backup.sh y villa-restore-test.sh al terminar bien, y
--    villa-alert.sh cuando la unidad falla, como postgres por el socket local (peer).
-- 3. Solo-inserción para todos los roles (triggers con public_forbid_mutation, como 0029).
-- 4. villa_app solo puede LEER (se le quita el INSERT que app_apply_grants da por defecto).
-- app_apply_grants parte de la última definición (0030) y solo agrega el REVOKE de backup_runs.
CREATE TABLE "backup_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"size_bytes" bigint,
	"detail" text,
	CONSTRAINT "backup_runs_kind_check" CHECK ("backup_runs"."kind" in ('backup','restore_test')),
	CONSTRAINT "backup_runs_size_check" CHECK ("backup_runs"."size_bytes" is null or "backup_runs"."size_bytes" >= 0),
	CONSTRAINT "backup_runs_detail_check" CHECK ("backup_runs"."detail" is null or length("backup_runs"."detail") <= 200)
);
--> statement-breakpoint
CREATE INDEX "backup_runs_kind_finished_idx" ON "backup_runs" USING btree ("kind","finished_at");
--> statement-breakpoint
CREATE TRIGGER backup_runs_no_mutation BEFORE UPDATE OR DELETE ON backup_runs
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER backup_runs_no_truncate BEFORE TRUNCATE ON backup_runs
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
  -- Respaldos (0031): la app solo los LEE. Los registran los scripts del VPS como postgres; si la app
  -- quedara comprometida, no podría fingir un respaldo que no se hizo.
  EXECUTE 'REVOKE INSERT ON backup_runs FROM villa_app';
  -- Ni su secuencia: sin INSERT no la necesita, y nextval() solo dejaría huecos (auditoría del sprint 9).
  EXECUTE 'REVOKE ALL ON SEQUENCE backup_runs_id_seq FROM villa_app';
  -- UPDATE solo donde la app modifica filas (y los triggers de cada tabla acotan qué cambia).
  -- NO están: accounts, journal_entries, journal_lines, day_close_events, appointment_events,
  -- client_consents, notifications, notification_events, sale_lines, sale_payments, sale_tips,
  -- cash_movements, expenses, personal_data_reads, audit_events, recurring_expense_runs.
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
  -- Gastos fijos (0028): editar la plantilla (nunca la sede, el id ni quién la creó). Sus periodos
  -- (recurring_expense_runs) son solo-inserción.
  EXECUTE 'GRANT UPDATE (name, category_id, estimated_amount, pay_mode, day_of_month, interval_months, start_month,
    active, updated_at) ON recurring_expenses TO villa_app';
  -- Latido del worker (0030): solo la hora del último latido (nunca el nombre del proceso).
  EXECUTE 'GRANT UPDATE (beat_at) ON worker_heartbeats TO villa_app';
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
