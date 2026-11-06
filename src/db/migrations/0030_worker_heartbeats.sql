-- Latido del worker. Problema que resuelve: el cobro encola el recibo (notifications, sale_receipt)
-- y lo entrega el worker (npm run worker). Si el worker no corre, el recibo queda en cola sin que
-- nadie lo note: la hoja de cobro decía "Se enviará por WhatsApp" y no salía nada.
-- 1. worker_heartbeats: una fila por proceso (name, p. ej. 'worker') con beat_at, la última vez que
--    respondió. El worker la escribe cada minuto (INSERT ... ON CONFLICT (name) DO UPDATE SET beat_at).
--    Infraestructura, como rate_limit_counters: sin location_id (un worker atiende todas las sedes).
--    Sin datos personales y sin purga: es una fila por proceso.
-- 2. Con avisos pendientes de la sede y el latido de más de 5 minutos (o sin latido), Caja e Inicio
--    muestran "Los envíos de WhatsApp y correo están detenidos" (src/db/worker-heartbeat.ts, en SQL).
-- 3. Para la app: SELECT e INSERT (el default de app_apply_grants) y UPDATE SOLO de beat_at.
--    Sin DELETE.
-- app_apply_grants parte de la última definición (0028) y solo agrega la línea de worker_heartbeats.
CREATE TABLE "worker_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeats_name_check" CHECK ("worker_heartbeats"."name" ~ '^[a-z][a-z0-9.-]{0,39}$')
);
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
