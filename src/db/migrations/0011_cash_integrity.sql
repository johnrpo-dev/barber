ALTER TABLE "cash_sessions" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "opening_needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "cash_review_threshold" bigint DEFAULT 2000000 NOT NULL;--> statement-breakpoint
CREATE INDEX "cash_sessions_needs_review_idx" ON "cash_sessions" USING btree ("location_id") WHERE ("cash_sessions"."needs_review" or "cash_sessions"."opening_needs_review") and "cash_sessions"."reviewed_at" is null;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closed_after_open_check" CHECK ("cash_sessions"."closed_at" is null or "cash_sessions"."closed_at" >= "cash_sessions"."opened_at");--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_review_check" CHECK (("cash_sessions"."reviewed_by" is null) = ("cash_sessions"."reviewed_at" is null)
        and ("cash_sessions"."reviewed_at" is null or (("cash_sessions"."needs_review" or "cash_sessions"."opening_needs_review") and "cash_sessions"."closed_at" is not null))
        and (not "cash_sessions"."needs_review" or "cash_sessions"."closed_at" is not null));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_cash_review_threshold_check" CHECK ("locations"."cash_review_threshold" >= 0 and "locations"."cash_review_threshold" % 100 = 0 and "locations"."cash_review_threshold" <= 10000000000000);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_commission_check" CHECK ("sale_lines"."commission" <= "sale_lines"."unit_price");
--> statement-breakpoint

-- ─── A mano: integridad de la caja y endurecimiento (revisiones del sprint 4) ───────────────
-- docs/sprint-4-cobro-caja.md §9.2. La app decide el flujo; la base asegura lo que no puede fallar:
--   1. Backfill: aperturas y cierres viejos con diferencia mayor que el umbral quedan para revisión.
--   2. Las horas de cierre, anulación y decisión las pone la base (now()), y las marcas de revisión
--      (apertura y cierre) las calcula la base con el umbral de la sede. El dueño da por revisado
--      un turno cerrado, una vez: esa revisión cubre la apertura y el cierre.
--   3. El efectivo del libro (1105) de una sede nunca queda negativo al hacer COMMIT (C1).
--   4. Cada fila operativa coincide con su asiento y cada asiento operativo tiene su fila (M2).
--   5. search_path fijo en TODAS las funciones de public (HIGH-1): una función "sombra" en otro
--      esquema no reemplaza a las de las garantías, aunque la sesión cambie su search_path.
--   6. Permisos de villa_app: la revisión del cierre.
--   7. Se borran los "dispositivos de confianza" de better-auth: el código se pide en cada ingreso.

-- 1. Backfill (el trigger de cierre no deja tocar un turno cerrado; aquí lo hace la migración).
ALTER TABLE cash_sessions DISABLE TRIGGER cash_sessions_before_update;
--> statement-breakpoint
UPDATE cash_sessions s
   SET needs_review = true
  FROM locations l
 WHERE l.id = s.location_id AND s.closed_at IS NOT NULL AND abs(s.difference) > l.cash_review_threshold;
--> statement-breakpoint
UPDATE cash_sessions s
   SET opening_needs_review = true
  FROM locations l
 WHERE l.id = s.location_id AND abs(s.opening_counted - s.opening_expected) > l.cash_review_threshold;
--> statement-breakpoint
ALTER TABLE cash_sessions ENABLE TRIGGER cash_sessions_before_update;
--> statement-breakpoint

-- 2. Turno de caja. Nace abierto y la marca de revisión de la APERTURA (|contado − libro| >
--    umbral) la pone la base; la app no puede fingirla ni quitarla.
CREATE OR REPLACE FUNCTION cash_sessions_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_threshold bigint;
BEGIN
  NEW.opened_at := now();
  IF NEW.closed_at IS NOT NULL OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.needs_review THEN
    RAISE EXCEPTION 'caja: un turno nace abierto' USING ERRCODE = 'check_violation';
  END IF;
  SELECT cash_review_threshold INTO v_threshold FROM locations WHERE id = NEW.location_id;
  NEW.opening_needs_review := coalesce(abs(NEW.opening_counted - NEW.opening_expected) > v_threshold, false);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
--    Se cierra una vez (la hora y la marca de revisión del cierre las pone la base); un turno
--    cerrado con alguna marca (apertura o cierre) se da por revisado una vez (quién lo escribe la
--    app; la hora, la base).
CREATE OR REPLACE FUNCTION cash_sessions_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_threshold bigint;
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    IF NOT (OLD.needs_review OR OLD.opening_needs_review) OR OLD.reviewed_at IS NOT NULL OR NEW.reviewed_by IS NULL
       OR (to_jsonb(NEW) - 'reviewed_by' - 'reviewed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'reviewed_by' - 'reviewed_at') THEN
      RAISE EXCEPTION 'caja: el turno % ya está cerrado; solo un cierre marcado para revisión se da por revisado, una vez', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewed_at := now();
    RETURN NEW;
  END IF;
  IF NEW.closed_at IS NULL OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'closed_by' - 'closed_at' - 'closing_counted' - 'expected_cash' - 'difference' - 'note'
           - 'closing_entry_id' - 'close_idempotency_key' - 'close_request_hash' - 'needs_review')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'closed_by' - 'closed_at' - 'closing_counted' - 'expected_cash' - 'difference' - 'note'
           - 'closing_entry_id' - 'close_idempotency_key' - 'close_request_hash' - 'needs_review') THEN
    RAISE EXCEPTION 'caja: el turno % solo pasa de abierto a cerrado, una vez', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.closed_at := now();
  SELECT cash_review_threshold INTO v_threshold FROM locations WHERE id = NEW.location_id;
  NEW.needs_review := coalesce(abs(NEW.difference) > v_threshold, false);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- La venta solo pasa a anulada con la reversa de su asiento; la hora la pone la base.
CREATE OR REPLACE FUNCTION sales_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_reverses bigint;
BEGIN
  IF OLD.status <> 'paid' OR NEW.status <> 'voided' OR NEW.void_entry_id IS NULL
     OR (to_jsonb(NEW) - 'status' - 'void_entry_id' - 'voided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'void_entry_id' - 'voided_at') THEN
    RAISE EXCEPTION 'cobro: la venta % es inmutable; solo una venta pagada pasa a anulada, una vez', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT reverses_entry_id INTO v_reverses FROM journal_entries WHERE id = NEW.void_entry_id AND location_id = NEW.location_id;
  IF v_reverses IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'cobro: la anulación de la venta % debe ser la reversa de su asiento', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.voided_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- La solicitud se decide una vez; la hora de la decisión la pone la base.
CREATE OR REPLACE FUNCTION void_requests_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'decision_idempotency_key' - 'decision_request_hash')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'decision_idempotency_key' - 'decision_request_hash') THEN
    RAISE EXCEPTION 'anulación: la solicitud % se decide una sola vez y no se edita', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (SELECT 1 FROM sales WHERE id = NEW.sale_id AND status = 'voided') THEN
    RAISE EXCEPTION 'anulación: aprobar la solicitud % exige anular la venta en la misma transacción', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 3. El efectivo del libro nunca queda negativo (C1). Se verifica al hacer COMMIT, ya con todas
--    las líneas de la transacción, cada vez que una línea ACREDITA la caja.
--    Robusto también en READ COMMITTED: dos transacciones que sacan efectivo a la vez podrían
--    verificar las dos antes de que la otra confirme y dejar 1105 negativo entre ambas. Por eso se
--    toma un candado de transacción por sede (pg_advisory_xact_lock, se suelta al terminar) antes de
--    sumar: la segunda espera a que la primera confirme y, como en READ COMMITTED cada consulta toma
--    una foto nueva, suma ya con sus líneas. En SERIALIZABLE (la app) además lo cubre SSI. Un
--    candado y no FOR UPDATE sobre la cuenta: villa_app no tiene UPDATE en accounts.
CREATE FUNCTION cash_assert_nonnegative() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND location_id = NEW.location_id AND code = '1105') THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('villa:cash:1105:' || NEW.location_id::text, 0));
  SELECT coalesce(sum(debit - credit), 0) INTO v_balance
    FROM journal_lines WHERE location_id = NEW.location_id AND account_id = NEW.account_id;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'caja: el efectivo del libro (1105) de la sede % quedaría negativo (% centavos); no sale más efectivo del que hay',
      NEW.location_id, v_balance USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_cash_nonnegative AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.credit > 0) EXECUTE FUNCTION cash_assert_nonnegative();
--> statement-breakpoint

-- 4. Filas operativas ↔ asientos (M2), al hacer COMMIT.
-- 4a. Un asiento de venta, gasto, pago de propinas o consignación tiene su fila operativa; la
--     reversa de un asiento de venta es la anulación de esa venta.
CREATE FUNCTION ledger_assert_operational_row() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ok boolean;
BEGIN
  v_ok := CASE NEW.kind
    WHEN 'sale' THEN EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id)
    WHEN 'expense' THEN EXISTS (SELECT 1 FROM expenses WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id)
    WHEN 'tip_payout' THEN EXISTS (
      SELECT 1 FROM cash_movements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id AND kind = 'tip_payout')
    WHEN 'cash_deposit' THEN EXISTS (
      SELECT 1 FROM cash_movements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id AND kind = 'cash_deposit')
    WHEN 'reversal' THEN
      NOT EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id)
      OR EXISTS (
        SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id AND void_entry_id = NEW.id)
    ELSE true
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'ledger: el asiento % (%) no tiene su registro operativo (venta, gasto o movimiento de caja)', NEW.id, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_operational_row AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind IN ('sale', 'expense', 'tip_payout', 'cash_deposit', 'reversal'))
  EXECUTE FUNCTION ledger_assert_operational_row();
--> statement-breakpoint
-- 4b. Un gasto: su asiento es de gasto, carga exactamente el monto a la cuenta de la categoría y lo
--     abona a 1105 (caja) o 1110 (banco); el de caja es un movimiento de su turno.
CREATE FUNCTION expenses_assert_entry() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_code text;
  v_debits numeric;
BEGIN
  SELECT kind INTO v_kind FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  SELECT account_code INTO v_code FROM expense_categories WHERE id = NEW.category_id AND location_id = NEW.location_id;
  SELECT coalesce(sum(debit), 0) INTO v_debits FROM journal_lines WHERE entry_id = NEW.journal_entry_id AND location_id = NEW.location_id;
  IF v_kind IS DISTINCT FROM 'expense' OR v_debits <> NEW.amount
     OR sales_entry_net(NEW.journal_entry_id, v_code) <> NEW.amount
     OR sales_entry_net(NEW.journal_entry_id, CASE NEW.paid_from WHEN 'cash' THEN '1105' ELSE '1110' END) <> -NEW.amount THEN
    RAISE EXCEPTION 'gastos: el asiento del gasto % no es exactamente su monto, de la cuenta de la categoría contra %',
      NEW.id, CASE NEW.paid_from WHEN 'cash' THEN 'la caja' ELSE 'el banco' END USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_from = 'cash' AND NOT EXISTS (
    SELECT 1 FROM cash_movements
     WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'expense'
       AND cash_session_id = NEW.cash_session_id
  ) THEN
    RAISE EXCEPTION 'gastos: el gasto de caja % no es un movimiento de su turno', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expenses_entry_matches AFTER INSERT ON expenses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION expenses_assert_entry();
--> statement-breakpoint
-- 4c. Un movimiento de caja: su asiento es de su mismo tipo y mueve efectivo en el sentido del tipo
--     (la venta entra; lo demás sale), por el monto de su fila (gasto) o de su contrapartida.
CREATE FUNCTION cash_movements_assert_entry() RETURNS trigger LANGUAGE plpgsql
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
  IF v_kind IS DISTINCT FROM NEW.kind OR v_cash = 0 OR (NEW.kind = 'sale') <> (v_cash > 0) THEN
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
    WHEN 'reversal' THEN EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = v_reverses)
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'caja: el monto del movimiento % (%) no coincide con su registro', NEW.id, NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cash_movements_entry_matches AFTER INSERT ON cash_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_movements_assert_entry();
--> statement-breakpoint
-- 4d. Al abrir y al cerrar un turno, el efectivo del libro es exactamente lo contado (el ajuste por
--     diferencia va en la misma transacción). Así expected_cash = 1105 antes del ajuste.
CREATE FUNCTION cash_sessions_assert_ledger() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_cash numeric;
  v_counted bigint;
BEGIN
  v_counted := CASE WHEN TG_OP = 'INSERT' THEN NEW.opening_counted ELSE NEW.closing_counted END;
  SELECT coalesce(sum(l.debit - l.credit), 0) INTO v_cash
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
   WHERE l.location_id = NEW.location_id AND a.code = '1105';
  IF v_cash IS DISTINCT FROM v_counted::numeric THEN
    RAISE EXCEPTION 'caja: al % el turno %, el efectivo del libro (% centavos) no es lo contado (% centavos)',
      CASE WHEN TG_OP = 'INSERT' THEN 'abrir' ELSE 'cerrar' END, NEW.id, v_cash, v_counted USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cash_sessions_ledger_on_open AFTER INSERT ON cash_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_sessions_assert_ledger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cash_sessions_ledger_on_close AFTER UPDATE ON cash_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)
  EXECUTE FUNCTION cash_sessions_assert_ledger();
--> statement-breakpoint
-- 4e. Una venta solo se anula con una solicitud aprobada (en la misma transacción).
CREATE FUNCTION sales_assert_void_approved() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM void_requests WHERE location_id = NEW.location_id AND sale_id = NEW.id AND status = 'approved') THEN
    RAISE EXCEPTION 'cobro: la venta % se anuló sin una solicitud aprobada', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_void_approved AFTER UPDATE ON sales
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status = 'paid' AND NEW.status = 'voided')
  EXECUTE FUNCTION sales_assert_void_approved();
--> statement-breakpoint

-- 5. search_path fijo (HIGH-1). Sin esto, una sesión que ponía otro esquema antes de public podía
--    reemplazar ledger_assert_entry() y compañía por una función suya y saltarse el cuadre, el día
--    cerrado, los totales y las anulaciones. pg_temp va de último: tampoco se cuelan tablas
--    temporales. src/db/roles.test.ts falla si una función de public queda sin search_path fijo.
ALTER FUNCTION ledger_forbid_mutation() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_day_lock_key(bigint, date) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_day_is_closed(bigint, date) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_before_insert_entry() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_before_insert_line() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_assert_entry(bigint) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_check_entry_from_entry() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_check_entry_from_line() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION ledger_before_insert_day_event() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION agenda_forbid_mutation() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION agenda_before_insert_appointment() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION agenda_before_update_appointment() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public_forbid_mutation() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION booking_verifications_before_update() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION appointment_links_before_update() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION appointments_request_hash_frozen() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION appointment_links_check_expiry() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_forbid_mutation() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION payment_methods_before_update() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION expense_categories_before_update() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_before_insert() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_child_before_insert() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_entry_net(bigint, text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_assert_totals(bigint) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION sales_check_totals() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION cash_sessions_before_insert() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION cash_requires_open_session() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION void_requests_before_insert() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION day_close_requires_closed_cash() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint

-- 6. Permisos de villa_app (la función de 0010, con search_path fijo y la revisión del cierre: la
--    app escribe quién revisó; la hora la pone el trigger). needs_review NO está: lo calcula la base.
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
  -- UPDATE solo donde la app modifica filas (y los triggers de cada tabla acotan qué cambia).
  -- NO están: accounts, journal_entries, journal_lines, day_close_events, appointment_events,
  -- client_consents, notifications, notification_events, sale_lines, sale_payments, sale_tips,
  -- cash_movements, expenses.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- Solo las columnas que cambian: editar un medio de pago o una categoría, anular una venta,
  -- cerrar un turno y darlo por revisado, decidir una solicitud.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash, reviewed_by) ON cash_sessions TO villa_app';
  EXECUTE 'GRANT UPDATE (status, decided_by, decided_at, decision_note, decision_idempotency_key, decision_request_hash)
    ON void_requests TO villa_app';
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
-- 7. Dispositivos de confianza (auditoría del sprint 4, LOW-6): la app ya rechaza trustDevice y
--    pide el código en cada ingreso; los registros que quedaron de antes se borran una vez.
DELETE FROM verification WHERE identifier LIKE 'trust-device-%';
--> statement-breakpoint
SELECT app_apply_grants();
