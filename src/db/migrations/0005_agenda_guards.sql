-- Garantías de la agenda, escritas a mano. El dominio (src/domain/booking) decide quién puede
-- hacer cada cambio; la base de datos asegura lo que no puede fallar aunque haya un error en la app:
--   1. Nunca dos citas activas del mismo barbero en el mismo rango (incluye la limpieza).
--   2. Solo transiciones de estado válidas; terminada y cancelada quedan congeladas.
--   3. Lo cotizado (servicio, duración, precio) no se edita después de agendar.
--   4. Nada se borra; el historial es solo-inserción.

-- 1. Sin doble reserva. cancelled y no_show liberan el horario.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_double_booking
  EXCLUDE USING gist (location_id WITH =, staff_id WITH =, during WITH &&)
  WHERE (status IN ('pending', 'confirmed', 'arrived', 'in_chair', 'completed'));
--> statement-breakpoint

CREATE INDEX appointments_pending_expiry_idx ON appointments (location_id, expires_at) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX appointments_client_idx ON appointments (location_id, client_id);
--> statement-breakpoint
CREATE INDEX time_off_during_idx ON time_off USING gist (location_id, staff_id, during) WHERE cancelled_at IS NULL;
--> statement-breakpoint

-- 4. Nada se borra.
CREATE FUNCTION agenda_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agenda: % no admite %; cancela o registra un cambio nuevo', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_no_delete BEFORE DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointments_no_truncate BEFORE TRUNCATE ON appointments
  FOR EACH STATEMENT EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_events_append_only BEFORE UPDATE OR DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_events_no_truncate BEFORE TRUNCATE ON appointment_events
  FOR EACH STATEMENT EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER time_off_no_delete BEFORE DELETE ON time_off
  FOR EACH ROW EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER time_off_no_truncate BEFORE TRUNCATE ON time_off
  FOR EACH STATEMENT EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint

-- Una cita nace pendiente (reserva en línea), confirmada (agendada por el personal) o
-- llegó (walk-in). Nunca nace terminada: eso solo ocurre atendiéndola.
CREATE FUNCTION agenda_before_insert_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed', 'arrived') THEN
    RAISE EXCEPTION 'agenda: una cita no puede crearse como %', NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_before_insert BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION agenda_before_insert_appointment();
--> statement-breakpoint

-- 2 y 3. La lista de transiciones es la misma de ALLOWED_TRANSITIONS en src/domain/booking/status.ts
-- (un test compara ambas).
CREATE FUNCTION agenda_before_update_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'agenda: la cita % está %; ya no se modifica', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.location_id <> OLD.location_id OR NEW.public_id <> OLD.public_id OR NEW.source <> OLD.source
     OR NEW.service_id <> OLD.service_id OR NEW.service_name <> OLD.service_name
     OR NEW.duration_min <> OLD.duration_min OR NEW.buffer_min <> OLD.buffer_min OR NEW.price <> OLD.price
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'agenda: el servicio, el precio y el origen de la cita % no se editan; cancélala y crea otra', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (
      ('pending', 'confirmed'), ('pending', 'cancelled'),
      ('confirmed', 'arrived'), ('confirmed', 'in_chair'), ('confirmed', 'cancelled'), ('confirmed', 'no_show'),
      ('arrived', 'in_chair'), ('arrived', 'cancelled'), ('arrived', 'confirmed'),
      ('in_chair', 'completed'), ('in_chair', 'arrived'),
      ('no_show', 'arrived')
    ) THEN
      RAISE EXCEPTION 'agenda: la cita % no puede pasar de % a %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;

  -- Mover de barbero u horario solo antes de empezar. Al terminar, el fin puede acortarse
  -- (termina antes y libera la silla), nunca alargarse ni moverse el inicio.
  IF NEW.staff_id <> OLD.staff_id OR NEW.during <> OLD.during THEN
    IF NOT (
      OLD.status IN ('pending', 'confirmed', 'arrived')
      OR (OLD.status = 'in_chair' AND NEW.status = 'completed' AND NEW.staff_id = OLD.staff_id
          AND lower(NEW.during) = lower(OLD.during) AND upper(NEW.during) <= upper(OLD.during))
    ) THEN
      RAISE EXCEPTION 'agenda: la cita % ya empezó; no se cambia de barbero ni de horario', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_before_update BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION agenda_before_update_appointment();
