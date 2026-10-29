ALTER TABLE "notifications" DROP CONSTRAINT "notifications_template_check";--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_contact_name_check" CHECK ("booking_verifications"."contact_name" is null or length("booking_verifications"."contact_name") between 2 and 80);--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_contact_email_check" CHECK ("booking_verifications"."contact_email" is null or ("booking_verifications"."contact_email" = lower("booking_verifications"."contact_email") and length("booking_verifications"."contact_email") <= 254));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_check" CHECK ("notifications"."template" in ('otp','booking_confirmed','reminder_24h','reminder_2h','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff'));--> statement-breakpoint

-- Auditoría de seguridad del sprint 3 (a mano): el nombre y el correo que escribió quien reserva
-- son evidencia como el resto y tampoco se editan. Misma función de 0007 con dos columnas más.
CREATE OR REPLACE FUNCTION booking_verifications_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
