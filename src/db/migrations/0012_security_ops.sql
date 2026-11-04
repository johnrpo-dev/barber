CREATE TABLE "personal_data_reads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "personal_data_reads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"context" text NOT NULL,
	"client_ids" bigint[] NOT NULL,
	"clients_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_data_reads_window_key" UNIQUE("location_id","staff_id","context","clients_hash","window_start"),
	CONSTRAINT "personal_data_reads_context_check" CHECK ("personal_data_reads"."context" in ('agenda_day','client_search')),
	CONSTRAINT "personal_data_reads_clients_check" CHECK (cardinality("personal_data_reads"."client_ids") between 1 and 500),
	CONSTRAINT "personal_data_reads_hash_check" CHECK ("personal_data_reads"."clients_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "security_alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "security_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"throttle_kind" text NOT NULL,
	"user_id" text,
	"failures" integer NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "security_alerts_kind_check" CHECK ("security_alerts"."kind" in ('login_lock')),
	CONSTRAINT "security_alerts_throttle_kind_check" CHECK ("security_alerts"."throttle_kind" in ('login','login-ip','reauth','password','totp-login')),
	CONSTRAINT "security_alerts_failures_check" CHECK ("security_alerts"."failures" >= 1),
	CONSTRAINT "security_alerts_occurrences_check" CHECK ("security_alerts"."occurrences" >= 1)
);
--> statement-breakpoint
ALTER TABLE "personal_data_reads" ADD CONSTRAINT "personal_data_reads_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_reads" ADD CONSTRAINT "personal_data_reads_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_data_reads_client_idx" ON "personal_data_reads" USING gin ("client_ids");--> statement-breakpoint
CREATE INDEX "personal_data_reads_created_idx" ON "personal_data_reads" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "security_alerts_pending_idx" ON "security_alerts" USING btree ("id") WHERE "security_alerts"."notified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "security_alerts_window_key" ON "security_alerts" USING btree ("throttle_kind",coalesce("user_id", ''),"window_start") WHERE "security_alerts"."notified_at" is null;
--> statement-breakpoint

-- ─── A mano: operación y seguridad del sprint 5 ──────────────────────────────────────────────
-- docs/arquitectura.md, "Seguridad: estado y plan". La app decide el flujo; la base asegura:
--   1. Retenciones de datos personales en un solo lugar (villa_pii_retention, villa_read_audit_retention).
--   2. booking_verifications: la IP, el navegador, el nombre y el correo escritos se pueden BORRAR
--      (poner en NULL, nada más) solo vencida la retención o con el cliente ya anonimizado.
--   3. notifications: los params se pueden vaciar ('{}', nada más) con las mismas condiciones. Lo
--      demás sigue solo-inserción (la cuota diaria y la evidencia de envío no cambian).
--   4. personal_data_reads (auditoría de lecturas, Ley 1581): solo-inserción; se borra solo pasada
--      su retención.
--   5. purge_expired_personal_data(): SECURITY DEFINER, dueña villa_owner, search_path fijo. Sin
--      parámetros: solo hace lo que ya venció (nadie le puede pasar otra fecha ni otra retención).
--      EXECUTE solo para villa_app (el mantenimiento diario del worker corre con ese rol).
--   6. Permisos de villa_app: security_alerts (sumar a la fila de la ventana, marcar entregado y
--      podar) y la purga.
--   7. security_alerts: un aviso sin entregar no se puede borrar.

-- 1. Retenciones. La política de privacidad (src/content/privacy) usa los mismos días;
--    src/db/privacy.test.ts compara las dos fuentes.
CREATE OR REPLACE FUNCTION villa_pii_retention() RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT interval '30 days' $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION villa_read_audit_retention() RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT interval '365 days' $$;
--> statement-breakpoint

-- Cliente ya anonimizado (supresión o reserva nunca confirmada): sus restos se borran sin esperar.
CREATE OR REPLACE FUNCTION villa_client_anonymized(p_location_id bigint, p_client_id bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_client_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM clients c WHERE c.location_id = p_location_id AND c.id = p_client_id AND c.anonymized_at IS NOT NULL)
$$;
--> statement-breakpoint

-- 2. booking_verifications: misma función de 0008 (search_path fijo en 0011) con la purga al inicio.
CREATE OR REPLACE FUNCTION booking_verifications_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed booking_verifications;
BEGIN
  -- Purga (Ley 1581): exactamente la IP, el navegador, el nombre y el correo pasan a NULL, y nada más.
  scrubbed := OLD;
  scrubbed.consent_ip := NULL;
  scrubbed.consent_user_agent := NULL;
  scrubbed.contact_name := NULL;
  scrubbed.contact_email := NULL;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed THEN
    IF OLD.created_at < now() - villa_pii_retention() OR villa_client_anonymized(OLD.location_id, OLD.client_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'reserva: los datos del código % todavía están dentro de su retención', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.location_id <> OLD.location_id OR NEW.appointment_id <> OLD.appointment_id OR NEW.client_id <> OLD.client_id
     OR NEW.channel <> OLD.channel OR NEW.code_hash <> OLD.code_hash OR NEW.browser_hash <> OLD.browser_hash
     OR NEW.max_attempts <> OLD.max_attempts OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR NEW.consent_choices <> OLD.consent_choices OR NEW.consent_text_version <> OLD.consent_text_version
     OR NEW.consent_ip IS DISTINCT FROM OLD.consent_ip OR NEW.consent_user_agent IS DISTINCT FROM OLD.consent_user_agent
     OR NEW.contact_name IS DISTINCT FROM OLD.contact_name OR NEW.contact_email IS DISTINCT FROM OLD.contact_email THEN
    RAISE EXCEPTION 'reserva: el código % y su evidencia no se editan', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.attempts NOT IN (OLD.attempts, OLD.attempts + 1) THEN
    RAISE EXCEPTION 'reserva: los intentos del código % solo suben de uno en uno', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.consumed_at IS NOT NULL OR OLD.superseded_at IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'reserva: el código % ya se usó o fue reemplazado', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.consumed_at IS NOT NULL THEN
    IF NEW.superseded_at IS NOT NULL OR now() >= OLD.expires_at OR NEW.attempts > OLD.max_attempts OR NEW.attempts = 0 THEN
      RAISE EXCEPTION 'reserva: el código % no se puede consumir (vencido, reemplazado o sin intentos)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.attempts > OLD.attempts AND (now() >= OLD.expires_at OR OLD.attempts >= OLD.max_attempts) THEN
    RAISE EXCEPTION 'reserva: el código % ya no admite intentos', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 3. notifications: DELETE sigue prohibido; UPDATE solo para vaciar los params vencidos.
DROP TRIGGER notifications_append_only ON notifications;
--> statement-breakpoint
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notifications_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed notifications;
BEGIN
  scrubbed := OLD;
  scrubbed.params := '{}'::jsonb;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed
     AND ((OLD.created_at < now() - villa_pii_retention() AND OLD.send_after < now() - villa_pii_retention())
          OR villa_client_anonymized(OLD.location_id, OLD.client_id)) THEN
    RETURN NEW;
  END IF;
  -- El mismo mensaje de public_forbid_mutation (0007): todo lo demás sigue siendo solo-inserción.
  RAISE EXCEPTION 'reserva: % no admite %; registra una fila nueva', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notifications_before_update BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_before_update();
--> statement-breakpoint

-- 4. Auditoría de lecturas: solo-inserción; se borra solo lo que pasó su retención.
CREATE OR REPLACE FUNCTION personal_data_reads_before_delete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.created_at < now() - villa_read_audit_retention() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'auditoría: % no admite DELETE dentro de su retención', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_data_reads_no_update BEFORE UPDATE ON personal_data_reads
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER personal_data_reads_before_delete BEFORE DELETE ON personal_data_reads
  FOR EACH ROW EXECUTE FUNCTION personal_data_reads_before_delete();
--> statement-breakpoint
CREATE TRIGGER personal_data_reads_no_truncate BEFORE TRUNCATE ON personal_data_reads
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint

-- 5. La purga. Sin parámetros a propósito: quien la llame solo consigue lo que el mantenimiento
--    diario haría de todos modos. Los triggers de arriba revisan otra vez cada fila.
CREATE OR REPLACE FUNCTION purge_expired_personal_data()
RETURNS TABLE (purged_verifications integer, purged_notifications integer, purged_reads integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v integer;
  n integer;
  r integer;
BEGIN
  UPDATE booking_verifications b
     SET consent_ip = NULL, consent_user_agent = NULL, contact_name = NULL, contact_email = NULL
   WHERE (b.consent_ip IS NOT NULL OR b.consent_user_agent IS NOT NULL OR b.contact_name IS NOT NULL OR b.contact_email IS NOT NULL)
     AND (b.created_at < now() - villa_pii_retention() OR villa_client_anonymized(b.location_id, b.client_id));
  GET DIAGNOSTICS v = ROW_COUNT;

  UPDATE notifications x
     SET params = '{}'::jsonb
   WHERE x.params <> '{}'::jsonb
     AND ((x.created_at < now() - villa_pii_retention() AND x.send_after < now() - villa_pii_retention())
          OR villa_client_anonymized(x.location_id, x.client_id));
  GET DIAGNOSTICS n = ROW_COUNT;

  DELETE FROM personal_data_reads p WHERE p.created_at < now() - villa_read_audit_retention();
  GET DIAGNOSTICS r = ROW_COUNT;

  RETURN QUERY SELECT v, n, r;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_personal_data() FROM PUBLIC;
--> statement-breakpoint
-- Si alguien migró como superusuario, la función SECURITY DEFINER no debe correr como tal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_owner') AND current_user <> 'villa_owner' THEN
    EXECUTE 'ALTER FUNCTION purge_expired_personal_data() OWNER TO villa_owner';
  END IF;
END;
$$;
--> statement-breakpoint

-- 6. Permisos de villa_app: los de 0011 más security_alerts y la purga. Una migración que redefina
--    esta función debe partir de ESTA versión.
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
  -- cash_movements, expenses, personal_data_reads.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- Solo las columnas que cambian: editar un medio de pago o una categoría, anular una venta,
  -- cerrar un turno y darlo por revisado, decidir una solicitud, marcar un aviso como entregado.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash, reviewed_by) ON cash_sessions TO villa_app';
  EXECUTE 'GRANT UPDATE (status, decided_by, decided_at, decision_note, decision_idempotency_key, decision_request_hash)
    ON void_requests TO villa_app';
  EXECUTE 'GRANT UPDATE (notified_at, occurrences, failures, locked_until) ON security_alerts TO villa_app';
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
END;
$$;
--> statement-breakpoint
-- 7. Un aviso de seguridad sin entregar no se borra: quien tome la app no puede esconder un bloqueo
--    borrando la fila antes de que el worker avise.
CREATE OR REPLACE FUNCTION security_alerts_before_delete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.notified_at IS NULL THEN
    RAISE EXCEPTION 'security_alerts: un aviso sin entregar no se borra';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_alerts_before_delete BEFORE DELETE ON security_alerts
  FOR EACH ROW EXECUTE FUNCTION security_alerts_before_delete();
--> statement-breakpoint

SELECT app_apply_grants();
