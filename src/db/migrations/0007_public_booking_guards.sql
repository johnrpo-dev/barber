-- Garantías de la reserva pública, escritas a mano (ver docs/sprint-3-reserva-publica.md).
-- La app decide el flujo; la base asegura lo que no puede fallar aunque la app tenga un error:
--   1. Reglas de la sede dentro de rangos sanos.
--   2. Un cliente tiene a lo sumo una retención pendiente por sede.
--   3. Autorizaciones, outbox y eventos de notificación son solo-inserción.
--   4. Un código se consume una sola vez, sin vencer y dentro de los intentos.
--   5. Un enlace de gestión no cambia de cita ni de token; revocarlo es definitivo.

-- 1. La retención debe alcanzar para el código y dos reenvíos.
ALTER TABLE locations ADD CONSTRAINT locations_hold_min_check CHECK (hold_min BETWEEN 10 AND 30);
--> statement-breakpoint
ALTER TABLE locations ADD CONSTRAINT locations_max_active_check CHECK (max_active_per_client BETWEEN 1 AND 10);
--> statement-breakpoint

-- 2. Una retención nueva del mismo cliente cancela la anterior antes de crearse.
CREATE UNIQUE INDEX appointments_one_pending_per_client ON appointments (location_id, client_id) WHERE status = 'pending';
--> statement-breakpoint

-- 3. Solo-inserción.
CREATE FUNCTION public_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reserva: % no admite %; registra una fila nueva', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER client_consents_append_only BEFORE UPDATE OR DELETE ON client_consents
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER client_consents_no_truncate BEFORE TRUNCATE ON client_consents
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER notifications_append_only BEFORE UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER notification_events_append_only BEFORE UPDATE OR DELETE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER notification_events_no_truncate BEFORE TRUNCATE ON notification_events
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER booking_verifications_no_delete BEFORE DELETE ON booking_verifications
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER booking_verifications_no_truncate BEFORE TRUNCATE ON booking_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_links_no_delete BEFORE DELETE ON appointment_links
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_links_no_truncate BEFORE TRUNCATE ON appointment_links
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint

-- 4. Un código: lo enviado no cambia; los intentos solo suben de uno en uno; se consume una
-- vez, solo si no venció, no fue reemplazado y no pasó de los intentos. Es la misma regla de
-- applyOtpAttempt en src/domain/verification/otp.ts.
CREATE FUNCTION booking_verifications_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id <> OLD.location_id OR NEW.appointment_id <> OLD.appointment_id OR NEW.client_id <> OLD.client_id
     OR NEW.channel <> OLD.channel OR NEW.code_hash <> OLD.code_hash OR NEW.browser_hash <> OLD.browser_hash
     OR NEW.max_attempts <> OLD.max_attempts OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR NEW.consent_choices <> OLD.consent_choices OR NEW.consent_text_version <> OLD.consent_text_version
     OR NEW.consent_ip IS DISTINCT FROM OLD.consent_ip OR NEW.consent_user_agent IS DISTINCT FROM OLD.consent_user_agent THEN
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
CREATE TRIGGER booking_verifications_before_update BEFORE UPDATE ON booking_verifications
  FOR EACH ROW EXECUTE FUNCTION booking_verifications_before_update();
--> statement-breakpoint

-- 5. Enlaces de gestión: la cita, el token y la generación no cambian; revocar es definitivo.
-- El vencimiento sí puede moverse (al reprogramar cambia el fin de la cita).
CREATE FUNCTION appointment_links_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id <> OLD.location_id OR NEW.appointment_id <> OLD.appointment_id OR NEW.token_hash <> OLD.token_hash
     OR NEW.generation <> OLD.generation OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'reserva: el enlace % no cambia de cita ni de token', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'reserva: el enlace % ya fue revocado', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_links_before_update BEFORE UPDATE ON appointment_links
  FOR EACH ROW EXECUTE FUNCTION appointment_links_before_update();
