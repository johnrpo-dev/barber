-- Productos e inventario periódico (sprint 6, fases A y B; docs/sprint-6-productos-inventario.md).
-- Lo genera drizzle-kit (tablas, CHECK de tipos de asiento, de movimientos de caja y de la bitácora) y
-- al final, a mano:
-- 1. Las cuentas 1435 (inventario) y 6135 (costo de ventas) en las sedes que ya existen
--    (createLocation las trae en las nuevas). Idempotente.
-- 2. Garantía clave: un trigger BEFORE INSERT sobre journal_lines rechaza cualquier línea sobre 1435 o
--    6135 cuyo asiento no sea inventory_purchase / inventory_count (o la reversa de uno de ellos). Y un
--    asiento de inventario solo toca sus cuentas: compra 1435 contra 1105, 1110 o 3105; conteo 1435 y 6135.
-- 3. Al hacer COMMIT: todo asiento de inventario tiene su documento, y cada documento cuadra con su
--    asiento (total = suma de líneas = débito a 1435; la contrapartida es la de paid_from; la compra de
--    caja es un movimiento de su turno). Un conteo deja 1435 exactamente en el valor contado.
-- 4. Documentos y líneas: solo-inserción (public_forbid_mutation, como 0029 y 0031); las líneas solo
--    entran en la transacción de su documento. Productos: no se borran.
-- 5. cash_movements_assert_entry (última definición: 0013) acepta el movimiento 'inventory_purchase'.
-- 6. app_apply_grants parte de la última definición (0031) y solo agrega el UPDATE de las columnas
--    editables de products.
-- No toca el constraint trigger que cuadra los asientos (0001) ni sales_assert_totals.
CREATE TABLE "inventory_document_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_document_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"document_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "inventory_document_lines_product_key" UNIQUE("document_id","product_id"),
	CONSTRAINT "inventory_document_lines_quantity_check" CHECK ("inventory_document_lines"."quantity" between 0 and 100000),
	CONSTRAINT "inventory_document_lines_amount_check" CHECK ("inventory_document_lines"."amount" >= 0 and "inventory_document_lines"."amount" <= 10000000000000)
);
--> statement-breakpoint
CREATE TABLE "inventory_documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"paid_from" text,
	"business_date" date NOT NULL,
	"journal_entry_id" bigint,
	"cash_session_id" bigint,
	"total" bigint NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_documents_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "inventory_documents_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "inventory_documents_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "inventory_documents_kind_check" CHECK ("inventory_documents"."kind" in ('purchase','count')),
	CONSTRAINT "inventory_documents_paid_from_check" CHECK (("inventory_documents"."paid_from" is null or "inventory_documents"."paid_from" in ('cash','bank','owner'))
        and ("inventory_documents"."kind" = 'purchase') = ("inventory_documents"."paid_from" is not null)
        and (coalesce("inventory_documents"."paid_from", '') = 'cash') = ("inventory_documents"."cash_session_id" is not null)),
	CONSTRAINT "inventory_documents_entry_check" CHECK ("inventory_documents"."kind" = 'count' or "inventory_documents"."journal_entry_id" is not null),
	CONSTRAINT "inventory_documents_total_check" CHECK ("inventory_documents"."total" >= 0 and "inventory_documents"."total" <= 10000000000000 and ("inventory_documents"."kind" = 'count' or ("inventory_documents"."total" > 0 and "inventory_documents"."total" % 100 = 0))),
	CONSTRAINT "inventory_documents_note_check" CHECK ("inventory_documents"."note" is null or (char_length("inventory_documents"."note") between 1 and 200 and "inventory_documents"."note" = btrim("inventory_documents"."note") and "inventory_documents"."note" !~ '[[:cntrl:]]')),
	CONSTRAINT "inventory_documents_request_hash_check" CHECK ("inventory_documents"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"price" bigint NOT NULL,
	"commission_bps" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "products_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "products_name_check" CHECK (char_length("products"."name") between 2 and 80 and "products"."name" = btrim("products"."name") and "products"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "products_sku_check" CHECK ("products"."sku" is null or (char_length("products"."sku") between 1 and 40 and "products"."sku" = btrim("products"."sku") and "products"."sku" !~ '[[:cntrl:]]')),
	CONSTRAINT "products_price_check" CHECK ("products"."price" >= 0 and "products"."price" % 100 = 0 and "products"."price" <= 10000000000000),
	CONSTRAINT "products_commission_check" CHECK ("products"."commission_bps" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_category_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_kind_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_kind_check";--> statement-breakpoint
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_document_fk" FOREIGN KEY ("location_id","document_id") REFERENCES "public"."inventory_documents"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_product_fk" FOREIGN KEY ("location_id","product_id") REFERENCES "public"."products"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_journal_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_document_lines_product_idx" ON "inventory_document_lines" USING btree ("location_id","product_id","document_id");--> statement-breakpoint
CREATE INDEX "inventory_documents_location_date_idx" ON "inventory_documents" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "products_location_name_key" ON "products" USING btree ("location_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "products_location_sku_key" ON "products" USING btree ("location_id",lower("sku")) WHERE "products"."sku" is not null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','appointment.courtesy','recurring_expense.register','recurring_expense.skip','inventory.purchase','inventory.count','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','recurring_expense.save','product.create','product.update','product.active','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','client.no_shows_clear','client.consent_withdraw','client.devices_forget','report.export'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('appointment.courtesy','finanzas'),('recurring_expense.register','finanzas'),('recurring_expense.skip','finanzas'),('inventory.purchase','finanzas'),('inventory.count','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('recurring_expense.save','configuracion'),('product.create','configuracion'),('product.update','configuracion'),('product.active','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('client.no_shows_clear','personal'),('client.consent_withdraw','personal'),('client.devices_forget','personal'),('report.export','informes')));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('sale','expense','tip_payout','cash_deposit','reversal','commission_payout','staff_advance','inventory_purchase'));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal','staff_advance','inventory_purchase','inventory_count'));--> statement-breakpoint

-- ─── A mano ───────────────────────────────────────────────────────────────────

-- 1. Cuentas 1435 y 6135 en las sedes existentes (las nuevas las trae createLocation). Repetible.
INSERT INTO accounts (location_id, code, name, type)
SELECT l.id, v.code, v.name, v.type
  FROM locations l
 CROSS JOIN (VALUES ('1435', 'Inventario de mercancía', 'asset'),
                    ('6135', 'Costo de los productos vendidos', 'expense')) AS v(code, name, type)
ON CONFLICT (location_id, code) DO NOTHING;
--> statement-breakpoint

-- 2. 1435 y 6135 solo las mueven los documentos de inventario. BEFORE INSERT, como
--    ledger_before_insert_line (0001): el asiento ya existe en la transacción cuando llegan sus líneas,
--    así que se rechaza al instante, antes del COMMIT. La reversa de un asiento de inventario hereda su
--    tipo (es su espejo exacto: lo exige ledger_assert_entry). Y al revés: un asiento de inventario no
--    toca cuentas ajenas (no se puede "comprar" contra un ingreso ni ajustar el conteo contra la caja).
CREATE FUNCTION ledger_inventory_line_guard() RETURNS trigger LANGUAGE plpgsql
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
  IF (v_kind = 'inventory_purchase' AND coalesce(v_code, '') NOT IN ('1435', '1105', '1110', '3105'))
     OR (v_kind = 'inventory_count' AND coalesce(v_code, '') NOT IN ('1435', '6135')) THEN
    RAISE EXCEPTION 'inventario: el asiento % (%) no puede tocar la cuenta %', NEW.entry_id, v_kind, v_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_inventory_accounts BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_inventory_line_guard();
--> statement-breakpoint

-- 3a. Al hacer COMMIT, todo asiento de inventario tiene su documento (como ledger_assert_operational_row
--     para ventas y gastos, pero en un trigger aparte: esa función no se toca).
CREATE FUNCTION inventory_assert_entry_document() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_documents
     WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id
       AND kind = CASE NEW.kind WHEN 'inventory_purchase' THEN 'purchase' ELSE 'count' END
  ) THEN
    RAISE EXCEPTION 'inventario: el asiento % (%) no tiene su documento de inventario', NEW.id, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_inventory_document AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind IN ('inventory_purchase', 'inventory_count'))
  EXECUTE FUNCTION inventory_assert_entry_document();
--> statement-breakpoint

-- 3b. Al hacer COMMIT, cada documento cuadra con su asiento y sus líneas.
--     Compra: al menos una línea, unidades > 0 y costos en pesos enteros; total = suma de las líneas =
--     débitos del asiento = lo que entra a 1435 = lo que sale de la cuenta de paid_from; la de caja es
--     un movimiento 'inventory_purchase' de su turno.
--     Conteo: total = suma de las líneas; su asiento (si hay) es de conteo; y después del conteo el
--     saldo de 1435 de la sede es EXACTAMENTE el valor contado.
CREATE FUNCTION inventory_documents_assert() RETURNS trigger LANGUAGE plpgsql
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
    v_source := CASE NEW.paid_from WHEN 'cash' THEN '1105' WHEN 'bank' THEN '1110' ELSE '3105' END;
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
CREATE CONSTRAINT TRIGGER inventory_documents_entry_matches AFTER INSERT ON inventory_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_documents_assert();
--> statement-breakpoint
-- La compra de caja exige el turno abierto (la misma función que cash_movements y expenses, 0010).
CREATE TRIGGER inventory_documents_open_session BEFORE INSERT ON inventory_documents
  FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint

-- 4. Solo-inserción, para cualquier rol (también el dueño del esquema), como 0029 y 0031.
CREATE TRIGGER inventory_documents_no_mutation BEFORE UPDATE OR DELETE ON inventory_documents
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_documents_no_truncate BEFORE TRUNCATE ON inventory_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_document_lines_no_mutation BEFORE UPDATE OR DELETE ON inventory_document_lines
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_document_lines_no_truncate BEFORE TRUNCATE ON inventory_document_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
-- Las líneas solo entran en la misma transacción que su documento (como las líneas de un asiento):
-- un documento confirmado no recibe líneas nuevas que cambien su total.
CREATE FUNCTION inventory_lines_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_documents WHERE id = NEW.document_id AND location_id = NEW.location_id AND created_at = now()
  ) THEN
    RAISE EXCEPTION 'inventario: el documento % ya está confirmado; no admite líneas nuevas', NEW.document_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_document_lines_before_insert BEFORE INSERT ON inventory_document_lines
  FOR EACH ROW EXECUTE FUNCTION inventory_lines_before_insert();
--> statement-breakpoint
-- Productos: se editan, no se borran (las compras, los conteos y las ventas los nombran). Al editar,
-- la sede, el id, el public_id y la fecha de creación no cambian.
CREATE TRIGGER products_no_delete BEFORE DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER products_no_truncate BEFORE TRUNCATE ON products
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION products_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventario: el producto % solo cambia nombre, referencia, precio, comisión y si está activo', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER products_before_update BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_before_update();
--> statement-breakpoint

-- 5. Un movimiento de caja: su asiento es de su mismo tipo y mueve efectivo en el sentido del tipo
--    (la venta entra; el gasto, las propinas, la consignación, la liquidación, el anticipo y la compra
--    de mercancía salen; la reversa, en sentido CONTRARIO al asiento que reversa), por el monto de su
--    fila. Igual a 0013 más el caso 'inventory_purchase'.
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
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'caja: el monto del movimiento % (%) no coincide con su registro', NEW.id, NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 6. Permisos de villa_app: la última definición (0031) más el UPDATE de las columnas editables de
--    products. inventory_documents e inventory_document_lines quedan solo-inserción (lo mínimo).
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
  -- Respaldos (0031): la app solo los LEE. Los registran los scripts del VPS como postgres; si la app
  -- quedara comprometida, no podría fingir un respaldo que no se hizo.
  EXECUTE 'REVOKE INSERT ON backup_runs FROM villa_app';
  -- Ni su secuencia: sin INSERT no la necesita, y nextval() solo dejaría huecos (auditoría del sprint 9).
  EXECUTE 'REVOKE ALL ON SEQUENCE backup_runs_id_seq FROM villa_app';
  -- UPDATE solo donde la app modifica filas (y los triggers de cada tabla acotan qué cambia).
  -- NO están: accounts, journal_entries, journal_lines, day_close_events, appointment_events,
  -- client_consents, notifications, notification_events, sale_lines, sale_payments, sale_tips,
  -- cash_movements, expenses, personal_data_reads, audit_events, recurring_expense_runs.
  -- Tampoco inventory_documents ni inventory_document_lines (0032): solo-inserción.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- Dispositivos recordados: solo marcar el último uso y revocar.
  FOREACH t IN ARRAY ARRAY['client_devices'] LOOP
    EXECUTE format('GRANT UPDATE (last_used_at, revoked_at) ON %I TO villa_app', t);
  END LOOP;
  -- Solo las columnas que cambian: editar un medio de pago o una categoría, anular una venta,
  -- cerrar un turno y darlo por revisado, decidir una solicitud, marcar un aviso como entregado,
  -- revertir una liquidación (y sus líneas) o un anticipo.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  -- Productos (0032): editar el catálogo (nunca la sede, el id, el public_id ni la fecha de creación).
  EXECUTE 'GRANT UPDATE (name, sku, price, commission_bps, active, updated_at) ON products TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash, reviewed_by) ON cash_sessions TO villa_app';
  EXECUTE 'GRANT UPDATE (status, decided_by, decided_at, decision_note, decision_idempotency_key, decision_request_hash)
    ON void_requests TO villa_app';
  EXECUTE 'GRANT UPDATE (notified_at, occurrences, failures, locked_until) ON security_alerts TO villa_app';
  -- Avisos al dueño (0027): solo marcar que el correo salió (el trigger exige null → fecha, una vez).
  EXECUTE 'GRANT UPDATE (notified_at) ON owner_alerts TO villa_app';
  -- Gastos fijos (0028): editar la plantilla (nunca la sede, el id ni quién la creó). Sus periodos
  -- (recurring_expense_runs) son solo-inserción.
  EXECUTE 'GRANT UPDATE (name, category_id, estimated_amount, pay_mode, day_of_month, interval_months, start_month,
    active, updated_at) ON recurring_expenses TO villa_app';
  -- Latido del worker (0030): solo la hora del último latido (nunca el nombre del proceso).
  EXECUTE 'GRANT UPDATE (beat_at) ON worker_heartbeats TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON commission_settlements TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON staff_advances TO villa_app';
  EXECUTE 'GRANT UPDATE (reversed) ON commission_settlement_lines TO villa_app';
  -- DELETE solo en lo efímero: sesiones y verificaciones de better-auth, el horario semanal
  -- (se reemplaza completo), los servicios de cada persona (se quitan al desmarcarlos), los contadores de límites, los avisos de seguridad ya entregados
  -- y los navegadores recordados que dejaron de servir hace más de 30 días (0025: un trigger lo exige fila por fila).
  -- owner_alerts NO está: los avisos al dueño no se borran (0027).
  FOREACH t IN ARRAY ARRAY[
    'session', 'verification', 'two_factor', 'staff_schedules', 'staff_services', 'rate_limit_counters',
    'login_throttles', 'security_alerts', 'client_devices'
  ] LOOP
    EXECUTE format('GRANT DELETE ON %I TO villa_app', t);
  END LOOP;
  -- La purga de datos personales: la llama el mantenimiento diario del worker (rol villa_app).
  EXECUTE 'REVOKE ALL ON FUNCTION purge_expired_personal_data() FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION purge_expired_personal_data() TO villa_app';
  -- La supresión a solicitud del titular: la llama la acción del dueño; la app no tiene UPDATE propio
  -- sobre esas columnas.
  EXECUTE 'REVOKE ALL ON FUNCTION erase_client_personal_data(bigint, bigint) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION erase_client_personal_data(bigint, bigint) TO villa_app';
END;
$$;
--> statement-breakpoint
SELECT app_apply_grants();