-- Cuentas por pagar: la base toma el candado de inventario de la sede antes de verificar (auditoría de
-- seguridad del sprint 8, parte A, hallazgo B-1). La app ya lo toma (lockInventory, bajo SERIALIZABLE),
-- pero los triggers diferidos de 0036 sumaban con la foto de su transacción: dos escritores que se
-- saltaran la app (READ COMMITTED, sin candado) podían pagar la misma compra a la vez, o pagarla
-- mientras otro la anulaba, y cada uno veía solo lo suyo. Ahora, al COMMIT:
-- 1. supplier_payments_assert (0036) actualiza primero la fila de la sede en inventory_locks. El
--    segundo espera al primero; en READ COMMITTED cada sentencia siguiente ve lo que el primero
--    confirmó, y en SERIALIZABLE o REPEATABLE READ el choque aborta con 40001 (y la app repite).
-- 2. Un trigger nuevo en journal_entries: la reversa de una compra a crédito toma el mismo candado y
--    vuelve a mirar que la compra no tenga pagos vigentes (lo mismo que exige inventory_assert_reversal
--    de 0036, pero después del candado).
-- La regla es la misma de 0036; solo cambia cuándo se mira. No toca el constraint trigger que cuadra
-- los asientos (0001) ni app_apply_grants (villa_app ya tiene INSERT y UPDATE (version) sobre
-- inventory_locks desde 0035).

CREATE FUNCTION inventory_lock_location(p_location_id bigint) RETURNS void LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO inventory_locks (location_id, version) VALUES (p_location_id, 1)
  ON CONFLICT (location_id) DO UPDATE SET version = inventory_locks.version + 1;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION supplier_payments_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_doc record;
  v_entry record;
  v_debits numeric;
  v_source text;
  v_paid numeric;
BEGIN
  -- Primero el candado: lo que sigue se mira con lo que ya confirmaron los demás pagos y anulaciones.
  PERFORM inventory_lock_location(NEW.location_id);
  SELECT id, total, journal_entry_id INTO v_doc
    FROM inventory_documents
   WHERE location_id = NEW.location_id AND id = NEW.document_id AND kind = 'purchase' AND paid_from = 'credit';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proveedores: el pago % no es de una compra a crédito de la sede', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE location_id = NEW.location_id AND reverses_entry_id = v_doc.journal_entry_id) THEN
    RAISE EXCEPTION 'proveedores: la compra % está anulada; no se le hacen pagos', v_doc.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT kind, business_date INTO v_entry FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  v_source := CASE NEW.paid_from WHEN 'cash' THEN '1105' WHEN 'bank' THEN '1110' ELSE '3105' END;
  SELECT coalesce(sum(debit), 0) INTO v_debits FROM journal_lines WHERE entry_id = NEW.journal_entry_id AND location_id = NEW.location_id;
  IF v_entry.kind IS DISTINCT FROM 'supplier_payment' OR v_entry.business_date IS DISTINCT FROM NEW.business_date
     OR v_debits <> NEW.amount
     OR sales_entry_net(NEW.journal_entry_id, '2205') <> NEW.amount
     OR sales_entry_net(NEW.journal_entry_id, v_source) <> -NEW.amount THEN
    RAISE EXCEPTION 'proveedores: el asiento del pago % no es exactamente su monto, de 2205 contra %', NEW.id, v_source
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_from = 'cash' AND NOT EXISTS (
    SELECT 1 FROM cash_movements
     WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'supplier_payment'
       AND cash_session_id = NEW.cash_session_id
  ) THEN
    RAISE EXCEPTION 'proveedores: el pago de caja % no es un movimiento de su turno', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(p.amount), 0) INTO v_paid
    FROM supplier_payments p
   WHERE p.location_id = NEW.location_id AND p.document_id = NEW.document_id
     AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.location_id = p.location_id AND r.reverses_entry_id = p.journal_entry_id);
  IF v_paid > v_doc.total THEN
    RAISE EXCEPTION 'proveedores: los pagos de la compra % (% centavos) superan su total (% centavos)', v_doc.id, v_paid, v_doc.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION supplier_credit_reversal_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_doc_id bigint;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT d.id INTO v_doc_id
    FROM inventory_documents d
   WHERE d.location_id = NEW.location_id AND d.journal_entry_id = NEW.reverses_entry_id
     AND d.kind = 'purchase' AND d.paid_from = 'credit';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM inventory_lock_location(NEW.location_id);
  IF EXISTS (
    SELECT 1 FROM supplier_payments p
     WHERE p.location_id = NEW.location_id AND p.document_id = v_doc_id
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.location_id = p.location_id AND r.reverses_entry_id = p.journal_entry_id)
  ) THEN
    RAISE EXCEPTION 'proveedores: la compra % tiene pagos vigentes; anúlalos antes de anular la compra', v_doc_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_entries_credit_reversal_lock AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_credit_reversal_assert();
