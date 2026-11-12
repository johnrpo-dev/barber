-- 0035: candado de inventario por sede (auditoría de seguridad del sprint 6, hallazgo M-1).
--
-- El candado consultivo (pg_advisory_xact_lock) de compra, conteo y anulación serializaba las
-- operaciones, pero en SERIALIZABLE la foto de datos se toma en la primera sentencia, ANTES de esperar
-- el candado: un conteo que esperaba a una compra leía 1435 y las últimas compras sin ella, y SSI no
-- garantiza abortarlo (no siempre hay ciclo). Ahora cada operación ACTUALIZA la fila de su sede en
-- inventory_locks: si otra transacción la cambió y confirmó después de la foto, Postgres aborta con
-- 40001 ("could not serialize access due to concurrent update") y serializable() repite con datos frescos.
--
-- app_apply_grants = la de 0032 más UPDATE (version) sobre inventory_locks. No toca el constraint
-- trigger que cuadra los asientos ni las garantías de inventario.
CREATE TABLE "inventory_locks" (
	"location_id" bigint PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_locks" ADD CONSTRAINT "inventory_locks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- ─── A mano ───────────────────────────────────────────────────────────────────

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
  -- Tampoco inventory_documents ni inventory_document_lines (0032): solo-inserción.
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
  -- Productos (0032): editar el catálogo (nunca la sede, el id, el public_id ni la fecha de creación).
  EXECUTE 'GRANT UPDATE (name, sku, price, commission_bps, active, updated_at) ON products TO villa_app';
  -- Candado de inventario por sede (0035): solo subir la versión (nunca la sede). Sin DELETE.
  EXECUTE 'GRANT UPDATE (version) ON inventory_locks TO villa_app';
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
