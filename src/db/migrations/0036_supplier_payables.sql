-- Cuentas por pagar a proveedores (sprint 8, parte A; docs/sprint-8-gastos-controles.md §5b).
-- Lo genera drizzle-kit (suppliers, supplier_payments, supplier_id y due_date en inventory_documents, y
-- los CHECK de tipos de asiento, movimientos de caja y bitácora) y al final, a mano:
-- 1. La cuenta 2205 (proveedores) en las sedes que ya existen.
-- 2. 2205 solo la mueven la compra a crédito y el pago a proveedor (o sus reversas); el pago solo toca
--    2205 contra 1105, 1110 o 3105 (ledger_inventory_line_guard, última definición: 0032).
-- 3. inventory_documents_assert (0032): la compra a crédito tiene su contrapartida en 2205.
-- 4 y 5. Al COMMIT: cada asiento de pago tiene su fila; cada pago es de una compra a crédito vigente,
--    mueve exactamente su monto y, sumado a los demás pagos vigentes, no supera el total de la compra.
-- 6. Pagos y proveedores: solo-inserción.
-- 7. cash_movements_assert_entry (0033) acepta el pago de caja y su anulación en el mismo turno.
-- 8. inventory_assert_reversal (0033): una compra a crédito con pagos vigentes no se anula; un pago de
--    caja se anula solo con su turno abierto.
-- No toca el constraint trigger que cuadra los asientos (0001), sales_assert_totals ni la definición
-- de app_apply_grants (0035).
CREATE TABLE "supplier_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"document_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"paid_from" text NOT NULL,
	"business_date" date NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"cash_session_id" bigint,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "supplier_payments_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "supplier_payments_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "supplier_payments_paid_from_check" CHECK ("supplier_payments"."paid_from" in ('cash','bank','owner') and ("supplier_payments"."paid_from" = 'cash') = ("supplier_payments"."cash_session_id" is not null)),
	CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount" > 0 and "supplier_payments"."amount" % 100 = 0 and "supplier_payments"."amount" <= 10000000000000),
	CONSTRAINT "supplier_payments_request_hash_check" CHECK ("supplier_payments"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suppliers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "suppliers_name_check" CHECK (char_length("suppliers"."name") between 2 and 80 and "suppliers"."name" = btrim("suppliers"."name") and "suppliers"."name" !~ '[[:cntrl:]]' and "suppliers"."name" !~ '  ')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_category_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_kind_check";--> statement-breakpoint
ALTER TABLE "inventory_documents" DROP CONSTRAINT "inventory_documents_paid_from_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_kind_check";--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD COLUMN "supplier_id" bigint;--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_document_fk" FOREIGN KEY ("location_id","document_id") REFERENCES "public"."inventory_documents"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_payments_document_idx" ON "supplier_payments" USING btree ("location_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_location_name_key" ON "suppliers" USING btree ("location_id",lower("name"));--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_supplier_fk" FOREIGN KEY ("location_id","supplier_id") REFERENCES "public"."suppliers"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_documents_supplier_idx" ON "inventory_documents" USING btree ("location_id","supplier_id") WHERE "inventory_documents"."supplier_id" is not null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','appointment.courtesy','recurring_expense.register','recurring_expense.skip','inventory.purchase','inventory.count','inventory.purchase_reverse','inventory.supplier_payment','inventory.supplier_payment_reverse','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','recurring_expense.save','product.create','product.update','product.active','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','client.no_shows_clear','client.consent_withdraw','client.devices_forget','report.export'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('appointment.courtesy','finanzas'),('recurring_expense.register','finanzas'),('recurring_expense.skip','finanzas'),('inventory.purchase','finanzas'),('inventory.count','finanzas'),('inventory.purchase_reverse','finanzas'),('inventory.supplier_payment','finanzas'),('inventory.supplier_payment_reverse','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('recurring_expense.save','configuracion'),('product.create','configuracion'),('product.update','configuracion'),('product.active','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('client.no_shows_clear','personal'),('client.consent_withdraw','personal'),('client.devices_forget','personal'),('report.export','informes')));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('sale','expense','tip_payout','cash_deposit','reversal','commission_payout','staff_advance','inventory_purchase','supplier_payment'));--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_credit_check" CHECK ((coalesce("inventory_documents"."paid_from", '') = 'credit') = ("inventory_documents"."supplier_id" is not null)
        and (coalesce("inventory_documents"."paid_from", '') = 'credit') = ("inventory_documents"."due_date" is not null)
        and ("inventory_documents"."due_date" is null or ("inventory_documents"."due_date" >= "inventory_documents"."business_date" and "inventory_documents"."due_date" <= "inventory_documents"."business_date" + 180)));--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_paid_from_check" CHECK (("inventory_documents"."paid_from" is null or "inventory_documents"."paid_from" in ('cash','bank','owner','credit'))
        and ("inventory_documents"."kind" = 'purchase') = ("inventory_documents"."paid_from" is not null)
        and (coalesce("inventory_documents"."paid_from", '') = 'cash') = ("inventory_documents"."cash_session_id" is not null));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal','staff_advance','inventory_purchase','inventory_count','supplier_payment'));--> statement-breakpoint

-- ─── A mano ───────────────────────────────────────────────────────────────────

-- 1. Cuenta 2205 (proveedores) en las sedes existentes (las nuevas la trae createLocation). Repetible.
INSERT INTO accounts (location_id, code, name, type)
SELECT l.id, '2205', 'Proveedores', 'liability' FROM locations l
ON CONFLICT (location_id, code) DO NOTHING;
--> statement-breakpoint

-- 2. Qué asientos tocan qué cuentas (0032 más 2205). 1435 y 6135: solo inventario. 2205: solo la compra
--    (a crédito) y el pago a proveedor, o sus reversas (que heredan el tipo de lo que reversan). Y al
--    revés: la compra solo toca 1435 contra 1105, 1110, 3105 o 2205; el conteo, 1435 y 6135; el pago,
--    2205 contra 1105, 1110 o 3105.
CREATE OR REPLACE FUNCTION ledger_inventory_line_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_code text;
  v_kind text;
  v_reverses bigint;
  v_effective text;
BEGIN
  SELECT code INTO v_code FROM accounts WHERE id = NEW.account_id AND location_id = NEW.location_id;
  SELECT kind, reverses_entry_id INTO v_kind, v_reverses
    FROM journal_entries WHERE id = NEW.entry_id AND location_id = NEW.location_id;
  v_effective := v_kind;
  IF v_kind = 'reversal' THEN
    SELECT kind INTO v_effective FROM journal_entries WHERE id = v_reverses AND location_id = NEW.location_id;
  END IF;
  IF v_code IN ('1435', '6135') AND coalesce(v_effective, '') NOT IN ('inventory_purchase', 'inventory_count') THEN
    RAISE EXCEPTION 'inventario: la cuenta % solo la mueven las compras y los conteos de inventario (asiento % de tipo %)',
      v_code, NEW.entry_id, v_kind USING ERRCODE = 'check_violation';
  END IF;
  IF v_code = '2205' AND coalesce(v_effective, '') NOT IN ('inventory_purchase', 'supplier_payment') THEN
    RAISE EXCEPTION 'proveedores: la cuenta 2205 solo la mueven las compras a crédito y los pagos a proveedores (asiento % de tipo %)',
      NEW.entry_id, v_kind USING ERRCODE = 'check_violation';
  END IF;
  IF (v_kind = 'inventory_purchase' AND coalesce(v_code, '') NOT IN ('1435', '1105', '1110', '3105', '2205'))
     OR (v_kind = 'inventory_count' AND coalesce(v_code, '') NOT IN ('1435', '6135'))
     OR (v_kind = 'supplier_payment' AND coalesce(v_code, '') NOT IN ('2205', '1105', '1110', '3105')) THEN
    RAISE EXCEPTION 'inventario: el asiento % (%) no puede tocar la cuenta %', NEW.entry_id, v_kind, v_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 3. El documento cuadra con su asiento (0032), ahora con la compra a crédito: su contrapartida es 2205.
CREATE OR REPLACE FUNCTION inventory_documents_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_lines bigint;
  v_sum numeric;
  v_bad bigint;
  v_kind text;
  v_debits numeric;
  v_source text;
  v_balance numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount), 0), count(*) FILTER (WHERE quantity = 0 OR amount % 100 <> 0)
    INTO v_lines, v_sum, v_bad
    FROM inventory_document_lines WHERE location_id = NEW.location_id AND document_id = NEW.id;
  IF v_sum <> NEW.total THEN
    RAISE EXCEPTION 'inventario: el total del documento % (% centavos) no es la suma de sus líneas (% centavos)', NEW.id, NEW.total, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT kind INTO v_kind FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  END IF;

  IF NEW.kind = 'purchase' THEN
    IF v_lines = 0 OR v_bad > 0 THEN
      RAISE EXCEPTION 'inventario: la compra % necesita líneas con unidades mayores que cero y costos en pesos enteros', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    v_source := CASE NEW.paid_from WHEN 'cash' THEN '1105' WHEN 'bank' THEN '1110' WHEN 'credit' THEN '2205' ELSE '3105' END;
    SELECT coalesce(sum(debit), 0) INTO v_debits
      FROM journal_lines WHERE entry_id = NEW.journal_entry_id AND location_id = NEW.location_id;
    IF v_kind IS DISTINCT FROM 'inventory_purchase' OR v_debits <> NEW.total
       OR sales_entry_net(NEW.journal_entry_id, '1435') <> NEW.total
       OR sales_entry_net(NEW.journal_entry_id, v_source) <> -NEW.total THEN
      RAISE EXCEPTION 'inventario: el asiento de la compra % no es exactamente su total, de 1435 contra %', NEW.id, v_source
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.paid_from = 'cash' AND NOT EXISTS (
      SELECT 1 FROM cash_movements
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'inventory_purchase'
         AND cash_session_id = NEW.cash_session_id
    ) THEN
      RAISE EXCEPTION 'inventario: la compra de caja % no es un movimiento de su turno', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.journal_entry_id IS NOT NULL AND v_kind IS DISTINCT FROM 'inventory_count' THEN
      RAISE EXCEPTION 'inventario: el asiento del conteo % no es de conteo', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(l.debit - l.credit), 0) INTO v_balance
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
     WHERE l.location_id = NEW.location_id AND a.code = '1435';
    IF v_balance <> NEW.total THEN
      RAISE EXCEPTION 'inventario: después del conteo %, el inventario del libro (1435: % centavos) no es el valor contado (% centavos)',
        NEW.id, v_balance, NEW.total USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 4. Al hacer COMMIT, todo asiento de pago a proveedor tiene su fila en supplier_payments.
CREATE FUNCTION supplier_payment_assert_entry_row() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier_payments WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id) THEN
    RAISE EXCEPTION 'proveedores: el asiento % (pago a proveedor) no tiene su pago', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_supplier_payment_row AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind = 'supplier_payment')
  EXECUTE FUNCTION supplier_payment_assert_entry_row();
--> statement-breakpoint

-- 5. Al hacer COMMIT, cada pago cuadra: es de una compra A CRÉDITO de la sede que no está anulada; su
--    asiento es de pago, del mismo día contable, y mueve exactamente su monto de 2205 contra su origen;
--    el de caja es un movimiento de su turno; y los pagos vigentes (sin reversa) de esa compra no suman
--    más que su total.
CREATE FUNCTION supplier_payments_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_doc record;
  v_entry record;
  v_debits numeric;
  v_source text;
  v_paid numeric;
BEGIN
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
CREATE CONSTRAINT TRIGGER supplier_payments_entry_matches AFTER INSERT ON supplier_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_payments_assert();
--> statement-breakpoint
-- El pago de caja exige el turno abierto (la misma función que cash_movements, expenses y compras).
CREATE TRIGGER supplier_payments_open_session BEFORE INSERT ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint

-- 6. Solo-inserción, para cualquier rol: los pagos se corrigen con la reversa de su asiento y los
--    proveedores no se quitan (las compras los nombran).
CREATE TRIGGER supplier_payments_no_mutation BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER supplier_payments_no_truncate BEFORE TRUNCATE ON supplier_payments
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER suppliers_no_mutation BEFORE UPDATE OR DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER suppliers_no_truncate BEFORE TRUNCATE ON suppliers
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint

-- 7. Movimientos de caja (0033 más el pago a proveedor): sale efectivo por el monto del pago, en su
--    turno; la anulación de un pago de caja devuelve el efectivo a ESE turno.
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
     OR (NEW.kind IN ('expense', 'tip_payout', 'cash_deposit', 'commission_payout', 'staff_advance', 'inventory_purchase', 'supplier_payment') AND v_cash > 0)
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
    WHEN 'supplier_payment' THEN EXISTS (
      SELECT 1 FROM supplier_payments
       WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id
         AND paid_from = 'cash' AND amount = -v_cash AND cash_session_id = NEW.cash_session_id)
    WHEN 'reversal' THEN
      EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      OR EXISTS (SELECT 1 FROM commission_settlements WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      OR EXISTS (SELECT 1 FROM staff_advances WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
      -- 0033: la anulación de una compra de caja devuelve el efectivo a SU turno (el mismo de la compra).
      OR EXISTS (
        SELECT 1 FROM inventory_documents
         WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses AND kind = 'purchase'
           AND paid_from = 'cash' AND cash_session_id = NEW.cash_session_id)
      -- 0036: igual con un pago a proveedor de la caja.
      OR EXISTS (
        SELECT 1 FROM supplier_payments
         WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses
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

-- 8. Reglas de la anulación al hacer COMMIT (0033 más proveedores):
--    - un conteo no se anula; una compra no se anula si hubo un conteo después;
--    - una compra a crédito con pagos vigentes no se anula (primero se anulan los pagos);
--    - la compra o el pago de caja exige su turno abierto y el movimiento de reversa en ese turno.
CREATE OR REPLACE FUNCTION inventory_assert_reversal() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_doc record;
  v_pay record;
BEGIN
  SELECT kind INTO v_kind FROM journal_entries WHERE id = NEW.reverses_entry_id AND location_id = NEW.location_id;
  IF v_kind = 'inventory_count' THEN
    RAISE EXCEPTION 'inventario: un conteo no se anula (asiento %); se corrige con otro conteo', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_kind = 'supplier_payment' THEN
    SELECT id, paid_from, cash_session_id INTO v_pay
      FROM supplier_payments WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id;
    IF v_pay.paid_from = 'cash' AND NOT (
      EXISTS (SELECT 1 FROM cash_sessions WHERE location_id = NEW.location_id AND id = v_pay.cash_session_id AND closed_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM cash_movements
         WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id AND kind = 'reversal'
           AND cash_session_id = v_pay.cash_session_id)
    ) THEN
      RAISE EXCEPTION 'proveedores: el pago de caja % solo se anula con su turno abierto, devolviendo el efectivo a ese turno', v_pay.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
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
  IF EXISTS (
    SELECT 1 FROM supplier_payments p
     WHERE p.location_id = NEW.location_id AND p.document_id = v_doc.id
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.location_id = p.location_id AND r.reverses_entry_id = p.journal_entry_id)
  ) THEN
    RAISE EXCEPTION 'proveedores: la compra % tiene pagos vigentes; anula primero los pagos', v_doc.id
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

-- 9. Permisos: suppliers y supplier_payments nacen solo-inserción para villa_app (lo mínimo de
--    app_apply_grants, sin cambiar su definición de 0035). Se vuelve a aplicar para las tablas nuevas.
SELECT app_apply_grants();
