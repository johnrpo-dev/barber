CREATE TABLE "login_throttles" (
	"subject" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "login_throttles_subject_check" CHECK ("login_throttles"."subject" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "login_throttles_failures_check" CHECK ("login_throttles"."failures" >= 1)
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factor_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "reauthenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_request_hash_check" CHECK ("appointments"."request_hash" is null or "appointments"."request_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_request_hash_check" CHECK ("journal_entries"."request_hash" is null or "journal_entries"."request_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- ─── A mano (endurecimiento del sprint 4, docs/arquitectura.md "Seguridad") ──────────────────

-- La huella de la petición es parte de la clave de idempotencia: no se edita.
CREATE FUNCTION appointments_request_hash_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'agenda: la huella de la petición de la cita % no se edita', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_request_hash_frozen BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_request_hash_frozen();
--> statement-breakpoint

-- Auditoría del sprint 3: el vencimiento de un enlace de gestión sigue a la cita (MANAGE_LINK_GRACE_DAYS
-- en src/domain/links/manage-token.ts) y no se puede alargar más allá de 7 días tras su fin.
CREATE FUNCTION appointment_links_check_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_end timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.expires_at = OLD.expires_at THEN
    RETURN NEW;
  END IF;
  SELECT upper(during) INTO v_end FROM appointments WHERE id = NEW.appointment_id AND location_id = NEW.location_id;
  IF v_end IS NULL OR NEW.expires_at > v_end + interval '7 days' THEN
    RAISE EXCEPTION 'reserva: el enlace % no puede vencer más de 7 días después del fin de la cita', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_links_check_expiry BEFORE INSERT OR UPDATE OF expires_at ON appointment_links
  FOR EACH ROW EXECUTE FUNCTION appointment_links_check_expiry();
--> statement-breakpoint

-- Roles de Postgres: villa_owner es dueño del esquema y corre las migraciones; villa_app es el rol
-- de la app y del worker. villa_app no es dueño de nada, así que no puede desactivar triggers,
-- borrarlos ni cambiar funciones; no tiene DDL ni TRUNCATE, y sobre las tablas solo-inserción
-- (libro, cierres, historial, consentimientos, avisos) solo tiene SELECT e INSERT.
-- Si el rol villa_app no existe (desarrollo local), no hace nada. Ver src/db/roles/setup-roles.sql.
-- TODA migración nueva que cree tablas debe terminar con: SELECT app_apply_grants();
CREATE FUNCTION app_apply_grants() RETURNS void LANGUAGE plpgsql AS $$
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
  -- client_consents, notifications, notification_events.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- DELETE solo en lo efímero: sesiones y verificaciones de better-auth, el horario semanal
  -- (se reemplaza completo) y los contadores de límites.
  FOREACH t IN ARRAY ARRAY[
    'session', 'verification', 'two_factor', 'staff_schedules', 'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT DELETE ON %I TO villa_app', t);
  END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app_apply_grants() FROM PUBLIC;
--> statement-breakpoint
SELECT app_apply_grants();