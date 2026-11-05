-- Cierre de caja tardío (la caja quedó abierta de un día anterior y se cerró al otro día):
-- el día D se puede cerrar aunque esté abierta la caja de un día POSTERIOR. Ese turno no recibe
-- cobros de D (la app no deja que una caja reciba efectivo de otro día); lo único fechado en D que
-- puede tocarlo es la reversa de una anulación, que ya quedó en el libro antes de cerrar D, y
-- después del cierre ya no entra (el día cerrado rechaza asientos). Sigue prohibido cerrar D con
-- una caja abierta ese día o antes.
CREATE OR REPLACE FUNCTION day_close_requires_closed_cash() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.action = 'close' AND EXISTS (
    SELECT 1
      FROM cash_sessions cs
      JOIN locations l ON l.id = cs.location_id
     WHERE cs.location_id = NEW.location_id
       AND cs.closed_at IS NULL
       AND (cs.opened_at AT TIME ZONE l.timezone)::date <= NEW.business_date
  ) THEN
    RAISE EXCEPTION 'ledger: cierra la caja antes de cerrar el día %', NEW.business_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
