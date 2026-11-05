-- Reserva más corta: el celular verificado una vez queda recordado en ese navegador (client_devices,
-- solo el hash del token) y la siguiente reserva no pide código. La supresión de datos del cliente
-- revoca esos dispositivos y ahora también borra el motivo de descuento de sus ventas (texto libre).
CREATE TABLE "client_devices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "client_devices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"client_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "client_devices_token_hash_check" CHECK ("client_devices"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "client_devices" ADD CONSTRAINT "client_devices_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_devices_client_idx" ON "client_devices" USING btree ("location_id","client_id");--> statement-breakpoint
-- sale_lines sigue siendo solo-inserción, con UNA excepción: la supresión de datos del cliente
-- reemplaza el motivo de descuento por '[suprimido]'. Ningún otro campo cambia (monto incluido).
DROP TRIGGER sale_lines_append_only ON sale_lines;
--> statement-breakpoint
CREATE TRIGGER sale_lines_no_delete BEFORE DELETE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sale_lines_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed sale_lines;
BEGIN
  scrubbed := OLD;
  scrubbed.discount_reason := '[suprimido]';
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND OLD.discount_reason IS NOT NULL AND EXISTS (
    SELECT 1 FROM sales s
     WHERE s.location_id = OLD.location_id AND s.id = OLD.sale_id AND villa_client_anonymized(s.location_id, s.client_id)
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cobro: % no admite %; corrige con una anulación o un registro nuevo', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sale_lines_before_update BEFORE UPDATE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION sale_lines_before_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION erase_client_personal_data(p_location_id bigint, p_client_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE clients
     SET name = 'Anónimo', phone_e164 = NULL, email = NULL, anonymized_at = coalesce(anonymized_at, now()), updated_at = now()
   WHERE location_id = p_location_id AND id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clientes: el cliente % no existe en la sede %', p_client_id, p_location_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE appointments
     SET notes = NULL, cancel_note = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id AND (notes IS NOT NULL OR cancel_note IS NOT NULL);

  UPDATE appointment_events e
     SET reason = NULL
    FROM appointments a
   WHERE e.location_id = p_location_id AND a.location_id = e.location_id AND a.id = e.appointment_id
     AND a.client_id = p_client_id AND e.reason IS NOT NULL;

  UPDATE appointment_links l
     SET revoked_at = now(), revoked_reason = 'staff'
    FROM appointments a
   WHERE l.location_id = p_location_id AND a.location_id = l.location_id AND a.id = l.appointment_id
     AND a.client_id = p_client_id AND l.revoked_at IS NULL;

  UPDATE booking_verifications
     SET consent_ip = NULL, consent_user_agent = NULL, contact_name = NULL, contact_email = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id
     AND (consent_ip IS NOT NULL OR consent_user_agent IS NOT NULL OR contact_name IS NOT NULL OR contact_email IS NOT NULL);

  UPDATE client_consents
     SET ip = NULL, user_agent = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id AND (ip IS NOT NULL OR user_agent IS NOT NULL);

  UPDATE notifications
     SET params = '{}'::jsonb
   WHERE location_id = p_location_id AND client_id = p_client_id AND params <> '{}'::jsonb;

  UPDATE notification_events e
     SET error_detail = NULL
    FROM notifications n
   WHERE e.location_id = p_location_id AND n.location_id = e.location_id AND n.id = e.notification_id
     AND n.client_id = p_client_id AND e.error_detail IS NOT NULL;

  UPDATE void_requests v
     SET reason = '[suprimido]', decision_note = CASE WHEN v.decision_note IS NULL THEN NULL ELSE '[suprimido]' END
    FROM sales s
   WHERE v.location_id = p_location_id AND s.location_id = v.location_id AND s.id = v.sale_id
     AND s.client_id = p_client_id AND v.reason <> '[suprimido]';

  UPDATE sale_lines l
     SET discount_reason = '[suprimido]'
    FROM sales s
   WHERE l.location_id = p_location_id AND s.location_id = l.location_id AND s.id = l.sale_id
     AND s.client_id = p_client_id AND l.discount_reason IS NOT NULL AND l.discount_reason <> '[suprimido]';

  UPDATE client_devices
     SET revoked_at = now()
   WHERE location_id = p_location_id AND client_id = p_client_id AND revoked_at IS NULL;

  UPDATE cash_movements m
     SET description = 'Anulación: [suprimido]'
    FROM journal_entries r
    JOIN sales s ON s.location_id = r.location_id AND s.journal_entry_id = r.reverses_entry_id
   WHERE m.location_id = p_location_id AND m.kind = 'reversal' AND r.location_id = m.location_id AND r.id = m.journal_entry_id
     AND s.client_id = p_client_id AND m.description <> 'Anulación: [suprimido]';
END;
$$;
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
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON commission_settlements TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON staff_advances TO villa_app';
  EXECUTE 'GRANT UPDATE (reversed) ON commission_settlement_lines TO villa_app';
  -- DELETE solo en lo efímero: sesiones y verificaciones de better-auth, el horario semanal
  -- (se reemplaza completo), los contadores de límites y los avisos de seguridad ya entregados.
  FOREACH t IN ARRAY ARRAY[
    'session', 'verification', 'two_factor', 'staff_schedules', 'rate_limit_counters', 'login_throttles', 'security_alerts'
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
