-- Anular una compra de mercancía mal registrada (sprint 6; docs/sprint-6-productos-inventario.md).
-- Lo genera drizzle-kit (la acción inventory.purchase_reverse en los CHECK de la bitácora) y al final,
-- a mano:
-- 1. cash_movements_assert_entry (última definición: 0032) acepta la reversa de una compra de caja,
--    solo como movimiento del MISMO turno de la compra.
-- 2. Al hacer COMMIT, la reversa de un asiento de inventario cumple las reglas de la anulación:
--    - un conteo no se anula (se corrige con otro conteo);
--    - una compra no se anula si hubo un conteo después (el conteo ya fijó el inventario);
--    - la de caja exige su turno todavía abierto y el movimiento de reversa en ese turno (el efectivo
--      vuelve a la caja de donde salió; con el turno cerrado, el arqueo ya absorbió la diferencia).
-- Las compras no se borran: la anulación es un asiento de reversa (reverseEntry), y la compra queda
-- anulada porque su asiento tiene reversa (journal_entries.reverses_entry_id es único: una sola vez).
-- No toca app_apply_grants ni el constraint trigger que cuadra los asientos.
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_category_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','appointment.courtesy','recurring_expense.register','recurring_expense.skip','inventory.purchase','inventory.count','inventory.purchase_reverse','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','recurring_expense.save','product.create','product.update','product.active','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','client.no_shows_clear','client.consent_withdraw','client.devices_forget','report.export'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('appointment.courtesy','finanzas'),('recurring_expense.register','finanzas'),('recurring_expense.skip','finanzas'),('inventory.purchase','finanzas'),('inventory.count','finanzas'),('inventory.purchase_reverse','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('recurring_expense.save','configuracion'),('product.create','configuracion'),('product.update','configuracion'),('product.active','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('client.no_shows_clear','personal'),('client.consent_withdraw','personal'),('client.devices_forget','personal'),('report.export','informes')));
--> statement-breakpoint

-- ─── A mano ───────────────────────────────────────────────────────────────────

-- 1. Igual a 0032 más la reversa de una compra de caja (en su mismo turno).
CREATE OR REPLACE FUNCTION cash_movements_assert_entry() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_reverses bigint;
  v_cash numeric;
  v_debits numeric;
  v_ok boolean;
BEGIN
  SELECT kind, reverses_entry_id INTO v_kind, v_reverses
    FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  v_cash := sales_entry_net(NEW.journal_entry_id, '1105');
  SELECT coalesce(sum(debit), 0) INTO v_debits FROM journal_lines WHERE entry_id = NEW.journal_entry_id AND location_id = NEW.location_id;
  IF v_kind IS DISTINCT FROM NEW.kind OR v_cash = 0
     OR (NEW.kind = 'sale' AND v_cash < 0)
     OR (NEW.kind IN ('expense', 'tip_payout', 'cash_deposit', 'commission_payout', 'staff_advance', 'inventory_purchase') AND v_cash > 0)
     OR (NEW.kind = 'reversal' AND v_cash <> -sales_entry_net(v_reverses, '1105')) THEN
    RAISE EXCEPTION 'caja: el movimiento % (%) no corresponde a su asiento o no mueve efectivo en su sentido', NEW.id, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  v_ok := CASE NEW.kind
    WHEN 'sale' THEN EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id)
    WHEN 'expense' THEN EXISTS (
      SELECT 1 FROM expenses
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND paid_from = 'cash'
         AND amount = -v_cash AND cash_session_id = NEW.cash_session_id)
    WHEN 'tip_payout' THEN v_debits = -v_cash AND sales_entry_net(NEW.journal_entry_id, '2380') = -v_cash
    WHEN 'cash_deposit' THEN v_debits = -v_cash AND sales_entry_net(NEW.journal_entry_id, '1110') = -v_cash
    WHEN 'commission_payout' THEN EXISTS (
      SELECT 1 FROM commission_settlements
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND paid_from = 'cash'
         AND payout = -v_cash AND cash_session_id = NEW.cash_session_id AND staff_id = NEW.staff_id)
    WHEN 'staff_advance' THEN EXISTS (
      SELECT 1 FROM staff_advances
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND paid_from = 'cash'
         AND amount = -v_cash AND cash_session_id = NEW.cash_session_id AND staff_id = NEW.staff_id)
    WHEN 'inventory_purchase' THEN EXISTS (
      SELECT 1 FROM inventory_documents
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'purchase'
         AND paid_from = 'cash' AND total = -v_cash AND cash_session_id = NEW.cash_session_id)
    WHEN 'reversal' THEN
      EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      OR EXISTS (SELECT 1 FROM commission_settlements WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      OR EXISTS (SELECT 1 FROM staff_advances WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      -- 0033: la anulación de una compra de caja devuelve el efectivo a SU turno (el mismo de la compra).
      OR EXISTS (
        SELECT 1 FROM inventory_documents
         WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses AND kind = 'purchase'
           AND paid_from = 'cash' AND cash_session_id = NEW.cash_session_id)
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'caja: el monto del movimiento % (%) no coincide con su registro', NEW.id, NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 2. Reglas de la anulación de un documento de inventario, al hacer COMMIT.
CREATE FUNCTION inventory_assert_reversal() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_doc record;
BEGIN
  SELECT kind INTO v_kind FROM journal_entries WHERE id = NEW.reverses_entry_id AND location_id = NEW.location_id;
  IF v_kind = 'inventory_count' THEN
    RAISE EXCEPTION 'inventario: un conteo no se anula (asiento %); se corrige con otro conteo', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind IS DISTINCT FROM 'inventory_purchase' THEN
    RETURN NULL;
  END IF;
  SELECT id, paid_from, cash_session_id INTO v_doc
    FROM inventory_documents
   WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id AND kind = 'purchase';
  IF EXISTS (SELECT 1 FROM inventory_documents WHERE location_id = NEW.location_id AND kind = 'count' AND id > v_doc.id) THEN
    RAISE EXCEPTION 'inventario: la compra % no se puede anular: hay un conteo posterior', v_doc.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_doc.paid_from = 'cash' AND NOT (
    EXISTS (SELECT 1 FROM cash_sessions WHERE location_id = NEW.location_id AND id = v_doc.cash_session_id AND closed_at IS NULL)
    AND EXISTS (
      SELECT 1 FROM cash_movements
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id AND kind = 'reversal'
         AND cash_session_id = v_doc.cash_session_id)
  ) THEN
    RAISE EXCEPTION 'inventario: la compra de caja % solo se anula con su turno abierto, devolviendo el efectivo a ese turno', v_doc.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_inventory_reversal AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind = 'reversal')
  EXECUTE FUNCTION inventory_assert_reversal();
