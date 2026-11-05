-- Auditoría del sprint 6 (B2): un navegador recordado revocado no vuelve a la vida. La app solo
-- puede mover last_used_at hacia adelante y poner revoked_at una vez; el token, el cliente, la sede
-- y las fechas de creación y vencimiento no cambian. Mismo criterio que appointment_links (0007).
CREATE FUNCTION client_devices_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.location_id <> OLD.location_id OR NEW.client_id <> OLD.client_id OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'reserva: el dispositivo % no cambia de cliente ni de token', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'reserva: el dispositivo % ya fue revocado', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
    RAISE EXCEPTION 'reserva: el último uso del dispositivo % no retrocede', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER client_devices_before_update BEFORE UPDATE ON client_devices
  FOR EACH ROW EXECUTE FUNCTION client_devices_before_update();
--> statement-breakpoint
SELECT app_apply_grants();
