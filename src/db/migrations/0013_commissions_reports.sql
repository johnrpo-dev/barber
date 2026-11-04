CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_staff_id" bigint,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_ref" text,
	"summary" text NOT NULL,
	"changes" jsonb,
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','report.export')),
	CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('report.export','informes'))),
	CONSTRAINT "audit_events_category_check" CHECK ("audit_events"."category" in ('finanzas','configuracion','personal','informes')),
	CONSTRAINT "audit_events_summary_check" CHECK (length("audit_events"."summary") between 1 and 300 and strpos("audit_events"."summary", chr(10)) = 0 and strpos("audit_events"."summary", chr(13)) = 0),
	CONSTRAINT "audit_events_target_check" CHECK (length("audit_events"."target_kind") between 1 and 40 and ("audit_events"."target_ref" is null or length("audit_events"."target_ref") between 1 and 80)),
	CONSTRAINT "audit_events_changes_check" CHECK ("audit_events"."changes" is null or (jsonb_typeof("audit_events"."changes") = 'array' and octet_length("audit_events"."changes"::text) <= 4096))
);
--> statement-breakpoint
CREATE TABLE "commission_settlement_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_settlement_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"settlement_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"sale_line_id" bigint,
	"amount" bigint NOT NULL,
	"reason" text,
	"reversed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "commission_settlement_lines_kind_check" CHECK ("commission_settlement_lines"."kind" in ('commission','clawback','tips','adjustment','advance_deduction','carry_over')),
	CONSTRAINT "commission_settlement_lines_shape_check" CHECK (("commission_settlement_lines"."kind" in ('commission','clawback')) = ("commission_settlement_lines"."sale_line_id" is not null)
        and ("commission_settlement_lines"."kind" = 'adjustment') = ("commission_settlement_lines"."reason" is not null)
        and ("commission_settlement_lines"."reason" is null or length(trim("commission_settlement_lines"."reason")) between 3 and 300)),
	CONSTRAINT "commission_settlement_lines_amount_check" CHECK ("commission_settlement_lines"."amount" <> 0 and "commission_settlement_lines"."amount" % 100 = 0 and abs("commission_settlement_lines"."amount") <= 10000000000000
        and ("commission_settlement_lines"."kind" not in ('commission','carry_over') or "commission_settlement_lines"."amount" > 0)
        and ("commission_settlement_lines"."kind" not in ('clawback','advance_deduction') or "commission_settlement_lines"."amount" < 0))
);
--> statement-breakpoint
CREATE TABLE "commission_settlements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_settlements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"public_id" text NOT NULL,
	"number" bigint DEFAULT 0 NOT NULL,
	"staff_id" bigint NOT NULL,
	"period_from" date NOT NULL,
	"cutoff_date" date NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'settled' NOT NULL,
	"paid_from" text,
	"cash_session_id" bigint,
	"commission_total" bigint NOT NULL,
	"clawback_total" bigint NOT NULL,
	"tips_total" bigint NOT NULL,
	"adjustments_total" bigint NOT NULL,
	"advance_deduction" bigint NOT NULL,
	"carry_over" bigint NOT NULL,
	"payout" bigint NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"reversal_entry_id" bigint,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reversal_reason" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reversal_idempotency_key" text,
	"reversal_request_hash" text,
	CONSTRAINT "commission_settlements_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "commission_settlements_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "commission_settlements_number_key" UNIQUE("location_id","number"),
	CONSTRAINT "commission_settlements_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "commission_settlements_reversal_idempotency_key" UNIQUE("location_id","reversal_idempotency_key"),
	CONSTRAINT "commission_settlements_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "commission_settlements_reversal_entry_key" UNIQUE("reversal_entry_id"),
	CONSTRAINT "commission_settlements_number_check" CHECK ("commission_settlements"."number" > 0),
	CONSTRAINT "commission_settlements_status_check" CHECK ("commission_settlements"."status" in ('settled','reversed')),
	CONSTRAINT "commission_settlements_payout_check" CHECK ("commission_settlements"."payout" = "commission_settlements"."commission_total" - "commission_settlements"."clawback_total" + "commission_settlements"."tips_total" + "commission_settlements"."adjustments_total" - "commission_settlements"."advance_deduction" + "commission_settlements"."carry_over"
        and "commission_settlements"."payout" >= 0 and "commission_settlements"."commission_total" >= 0 and "commission_settlements"."clawback_total" >= 0 and "commission_settlements"."advance_deduction" >= 0 and "commission_settlements"."carry_over" >= 0
        and not ("commission_settlements"."advance_deduction" > 0 and "commission_settlements"."carry_over" > 0) and ("commission_settlements"."carry_over" = 0 or "commission_settlements"."payout" = 0)
        and "commission_settlements"."payout" <= 10000000000000),
	CONSTRAINT "commission_settlements_whole_pesos_check" CHECK ("commission_settlements"."commission_total" % 100 = 0 and "commission_settlements"."clawback_total" % 100 = 0 and "commission_settlements"."tips_total" % 100 = 0 and "commission_settlements"."adjustments_total" % 100 = 0
        and "commission_settlements"."advance_deduction" % 100 = 0 and "commission_settlements"."carry_over" % 100 = 0 and "commission_settlements"."payout" % 100 = 0),
	CONSTRAINT "commission_settlements_paid_from_check" CHECK (("commission_settlements"."paid_from" is null) = ("commission_settlements"."payout" = 0) and ("commission_settlements"."paid_from" is null or "commission_settlements"."paid_from" in ('cash','bank'))
        and ("commission_settlements"."cash_session_id" is not null) = ("commission_settlements"."paid_from" is not distinct from 'cash')),
	CONSTRAINT "commission_settlements_dates_check" CHECK ("commission_settlements"."period_from" <= "commission_settlements"."cutoff_date" and "commission_settlements"."cutoff_date" <= "commission_settlements"."business_date"),
	CONSTRAINT "commission_settlements_reversed_check" CHECK (("commission_settlements"."status" = 'reversed') = ("commission_settlements"."reversal_entry_id" is not null)
        and ("commission_settlements"."status" = 'reversed') = ("commission_settlements"."reversed_at" is not null)
        and ("commission_settlements"."status" = 'reversed') = ("commission_settlements"."reversed_by" is not null)
        and ("commission_settlements"."status" = 'reversed') = ("commission_settlements"."reversal_idempotency_key" is not null)
        and ("commission_settlements"."status" = 'reversed') = ("commission_settlements"."reversal_request_hash" is not null)
        and ("commission_settlements"."status" <> 'reversed' or length(trim("commission_settlements"."reversal_reason")) between 3 and 300)),
	CONSTRAINT "commission_settlements_note_check" CHECK ("commission_settlements"."note" is null or length(trim("commission_settlements"."note")) between 1 and 300),
	CONSTRAINT "commission_settlements_hash_check" CHECK ("commission_settlements"."request_hash" ~ '^[0-9a-f]{64}$' and ("commission_settlements"."reversal_request_hash" is null or "commission_settlements"."reversal_request_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "staff_advances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_advances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"public_id" text NOT NULL,
	"number" bigint DEFAULT 0 NOT NULL,
	"staff_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"paid_from" text NOT NULL,
	"cash_session_id" bigint,
	"business_date" date NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reversal_entry_id" bigint,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reversal_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reversal_idempotency_key" text,
	"reversal_request_hash" text,
	CONSTRAINT "staff_advances_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "staff_advances_number_key" UNIQUE("location_id","number"),
	CONSTRAINT "staff_advances_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "staff_advances_reversal_idempotency_key" UNIQUE("location_id","reversal_idempotency_key"),
	CONSTRAINT "staff_advances_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "staff_advances_reversal_entry_key" UNIQUE("reversal_entry_id"),
	CONSTRAINT "staff_advances_number_check" CHECK ("staff_advances"."number" > 0),
	CONSTRAINT "staff_advances_amount_check" CHECK ("staff_advances"."amount" > 0 and "staff_advances"."amount" % 100 = 0 and "staff_advances"."amount" <= 10000000000000),
	CONSTRAINT "staff_advances_paid_from_check" CHECK ("staff_advances"."paid_from" in ('cash','bank') and ("staff_advances"."paid_from" = 'cash') = ("staff_advances"."cash_session_id" is not null)),
	CONSTRAINT "staff_advances_reason_check" CHECK (length(trim("staff_advances"."reason")) between 3 and 300),
	CONSTRAINT "staff_advances_status_check" CHECK ("staff_advances"."status" in ('active','reversed')),
	CONSTRAINT "staff_advances_reversed_check" CHECK (("staff_advances"."status" = 'reversed') = ("staff_advances"."reversal_entry_id" is not null)
        and ("staff_advances"."status" = 'reversed') = ("staff_advances"."reversed_at" is not null)
        and ("staff_advances"."status" = 'reversed') = ("staff_advances"."reversed_by" is not null)
        and ("staff_advances"."status" = 'reversed') = ("staff_advances"."reversal_idempotency_key" is not null)
        and ("staff_advances"."status" = 'reversed') = ("staff_advances"."reversal_request_hash" is not null)
        and ("staff_advances"."status" <> 'reversed' or length(trim("staff_advances"."reversal_reason")) between 3 and 300)),
	CONSTRAINT "staff_advances_hash_check" CHECK ("staff_advances"."request_hash" ~ '^[0-9a-f]{64}$' and ("staff_advances"."reversal_request_hash" is null or "staff_advances"."reversal_request_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_kind_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_staff_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_kind_check";--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_location_id_id_key" UNIQUE("location_id","id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_staff_fk" FOREIGN KEY ("location_id","actor_staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_lines" ADD CONSTRAINT "commission_settlement_lines_settlement_fk" FOREIGN KEY ("location_id","settlement_id") REFERENCES "public"."commission_settlements"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_lines" ADD CONSTRAINT "commission_settlement_lines_sale_line_fk" FOREIGN KEY ("location_id","sale_line_id") REFERENCES "public"."sale_lines"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlements" ADD CONSTRAINT "commission_settlements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlements" ADD CONSTRAINT "commission_settlements_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlements" ADD CONSTRAINT "commission_settlements_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlements" ADD CONSTRAINT "commission_settlements_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlements" ADD CONSTRAINT "commission_settlements_reversal_entry_fk" FOREIGN KEY ("location_id","reversal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_advances" ADD CONSTRAINT "staff_advances_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_advances" ADD CONSTRAINT "staff_advances_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_advances" ADD CONSTRAINT "staff_advances_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_advances" ADD CONSTRAINT "staff_advances_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_advances" ADD CONSTRAINT "staff_advances_reversal_entry_fk" FOREIGN KEY ("location_id","reversal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_location_id_idx" ON "audit_events" USING btree ("location_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_location_occurred_idx" ON "audit_events" USING btree ("location_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_settlement_lines_commission_once" ON "commission_settlement_lines" USING btree ("location_id","sale_line_id") WHERE "commission_settlement_lines"."kind" = 'commission' and not "commission_settlement_lines"."reversed";--> statement-breakpoint
CREATE UNIQUE INDEX "commission_settlement_lines_clawback_once" ON "commission_settlement_lines" USING btree ("location_id","sale_line_id") WHERE "commission_settlement_lines"."kind" = 'clawback' and not "commission_settlement_lines"."reversed";--> statement-breakpoint
CREATE UNIQUE INDEX "commission_settlement_lines_single_kind" ON "commission_settlement_lines" USING btree ("settlement_id","kind") WHERE "commission_settlement_lines"."kind" in ('tips','advance_deduction','carry_over');--> statement-breakpoint
CREATE INDEX "commission_settlement_lines_settlement_idx" ON "commission_settlement_lines" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "commission_settlement_lines_sale_line_idx" ON "commission_settlement_lines" USING btree ("location_id","sale_line_id");--> statement-breakpoint
CREATE INDEX "commission_settlements_staff_idx" ON "commission_settlements" USING btree ("location_id","staff_id","number");--> statement-breakpoint
CREATE INDEX "commission_settlements_location_date_idx" ON "commission_settlements" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "staff_advances_staff_idx" ON "staff_advances" USING btree ("location_id","staff_id","number");--> statement-breakpoint
CREATE INDEX "appointments_location_start_idx" ON "appointments" USING btree ("location_id",lower("during"));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('sale','expense','tip_payout','cash_deposit','reversal','commission_payout','staff_advance'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_staff_check" CHECK (("cash_movements"."kind" in ('tip_payout','commission_payout','staff_advance')) = ("cash_movements"."staff_id" is not null));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal','staff_advance'));
--> statement-breakpoint

CREATE INDEX "sale_lines_staff_commission_idx" ON "sale_lines" USING btree ("location_id","staff_id") WHERE "sale_lines"."commission" > 0;
--> statement-breakpoint

-- Hasta este sprint nada creaba asientos commission_payout. Si existen, se pagaron comisiones por
-- fuera de la liquidación y los saldos de abajo las darían como pendientes: se revisa a mano antes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE kind = 'commission_payout') THEN
    RAISE EXCEPTION 'migración 0013: ya hay asientos commission_payout; revísalos antes de migrar (quedarían como comisiones pendientes)'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint

-- ─── A mano: comisiones, anticipos y bitácora (sprint 5) ───────────────────────────────────
-- docs/sprint-5-comisiones-informes.md §2, §4, §8 y §12.6. La app decide el flujo; la base asegura
-- lo que no puede fallar aunque la app tenga un error:
--   1. La cuenta 1365 en cada sede existente.
--   2. Saldos por persona (2335, 2380 y 1365): funciones SQL, la ÚNICA definición.
--   3. Liquidaciones, líneas y anticipos: solo-inserción, salvo el paso único a revertida; número
--      consecutivo por sede; líneas solo en la transacción de su liquidación; reglas de commission
--      y clawback; al COMMIT, totales = líneas = asiento, completitud, saldos y caja.
--   4. Bitácora: solo-inserción, la hora la pone la base.
--   5. Libro y caja: commission_payout y staff_advance solo con su fila operativa; la reversa de
--      una venta, liquidación o anticipo solo como reversa de su fila; un movimiento de reversa
--      mueve efectivo en sentido contrario al asiento que reversa.
--   6. Permisos de villa_app.

-- 1. Cuenta 1365 (createLocation la trae en las sedes nuevas).
INSERT INTO accounts (location_id, code, name, type)
SELECT id, '1365', 'Cuentas por cobrar a trabajadores (anticipos)', 'asset' FROM locations
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- 2. Saldos por persona. Sumadas sobre todas las personas dan el saldo del libro de 2335, 2380 y
--    1365 (prueba de propiedades en src/db/commissions.pg.test.ts).
--    Comisión que se le debe (2335). Negativo = ya se le pagó una comisión que se anuló.
CREATE FUNCTION staff_commission_owed(p_location bigint, p_staff bigint) RETURNS numeric LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT sum(l.commission)
                     FROM sale_lines l JOIN sales s ON s.location_id = l.location_id AND s.id = l.sale_id
                    WHERE l.location_id = p_location AND l.staff_id = p_staff AND s.status = 'paid'), 0)
       - coalesce((SELECT sum(c.amount)
                     FROM commission_settlement_lines c
                     JOIN commission_settlements st ON st.location_id = c.location_id AND st.id = c.settlement_id
                    WHERE c.location_id = p_location AND st.staff_id = p_staff
                      AND c.kind IN ('commission', 'clawback') AND NOT c.reversed), 0)
$$;
--> statement-breakpoint
--    Propinas que se le deben (2380): causadas en ventas pagadas, menos lo pagado en Caja y en
--    liquidaciones vigentes.
CREATE FUNCTION staff_tips_owed(p_location bigint, p_staff bigint) RETURNS numeric LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT sum(t.payable)
                     FROM sale_tips t JOIN sales s ON s.location_id = t.location_id AND s.id = t.sale_id
                    WHERE t.location_id = p_location AND t.staff_id = p_staff AND s.status = 'paid'), 0)
       - coalesce((SELECT sum(l.debit - l.credit)
                     FROM cash_movements m
                     JOIN journal_lines l ON l.location_id = m.location_id AND l.entry_id = m.journal_entry_id
                     JOIN accounts a ON a.location_id = l.location_id AND a.id = l.account_id
                    WHERE m.location_id = p_location AND m.staff_id = p_staff AND m.kind = 'tip_payout'
                      AND a.code = '2380'), 0)
       - coalesce((SELECT sum(c.amount)
                     FROM commission_settlement_lines c
                     JOIN commission_settlements st ON st.location_id = c.location_id AND st.id = c.settlement_id
                    WHERE c.location_id = p_location AND st.staff_id = p_staff AND c.kind = 'tips' AND NOT c.reversed), 0)
$$;
--> statement-breakpoint
--    Lo que la persona le debe al negocio (1365). La base exige que nunca sea negativo.
CREATE FUNCTION staff_receivable(p_location bigint, p_staff bigint) RETURNS numeric LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT sum(a.amount) FROM staff_advances a
                    WHERE a.location_id = p_location AND a.staff_id = p_staff AND a.status = 'active'), 0)
       + coalesce((SELECT sum(c.amount)
                     FROM commission_settlement_lines c
                     JOIN commission_settlements st ON st.location_id = c.location_id AND st.id = c.settlement_id
                    WHERE c.location_id = p_location AND st.staff_id = p_staff
                      AND c.kind IN ('carry_over', 'advance_deduction') AND NOT c.reversed), 0)
$$;
--> statement-breakpoint

-- 3. Liquidaciones y anticipos.
-- 3a. Solo-inserción (DELETE y TRUNCATE prohibidos; UPDATE solo como dicen los triggers de abajo).
CREATE FUNCTION commissions_forbid_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'comisiones: % no admite %; corrige con una reversa', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_settlements_no_delete BEFORE DELETE ON commission_settlements
  FOR EACH ROW EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_settlements_no_truncate BEFORE TRUNCATE ON commission_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_settlement_lines_no_delete BEFORE DELETE ON commission_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_settlement_lines_no_truncate BEFORE TRUNCATE ON commission_settlement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER staff_advances_no_delete BEFORE DELETE ON staff_advances
  FOR EACH ROW EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER staff_advances_no_truncate BEFORE TRUNCATE ON staff_advances
  FOR EACH STATEMENT EXECUTE FUNCTION commissions_forbid_mutation();
--> statement-breakpoint
-- 3b. El efectivo solo sale con la caja abierta (la función de 0010).
CREATE TRIGGER commission_settlements_open_session BEFORE INSERT ON commission_settlements
  FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint
CREATE TRIGGER staff_advances_open_session BEFORE INSERT ON staff_advances
  FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint
-- 3c. Nacen vigentes, con número consecutivo por sede y serie (candado de transacción por sede:
--     dos liquidaciones simultáneas no toman el mismo número) y con la hora de la base.
CREATE FUNCTION commission_settlements_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'settled' OR NEW.reversal_entry_id IS NOT NULL OR NEW.reversed_at IS NOT NULL OR NEW.reversed_by IS NOT NULL
     OR NEW.reversal_reason IS NOT NULL OR NEW.reversal_idempotency_key IS NOT NULL OR NEW.reversal_request_hash IS NOT NULL THEN
    RAISE EXCEPTION 'comisiones: una liquidación nace vigente' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('villa:settlement-number:' || NEW.location_id::text, 0));
  SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM commission_settlements WHERE location_id = NEW.location_id;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_settlements_before_insert BEFORE INSERT ON commission_settlements
  FOR EACH ROW EXECUTE FUNCTION commission_settlements_before_insert();
--> statement-breakpoint
CREATE FUNCTION staff_advances_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.reversal_entry_id IS NOT NULL OR NEW.reversed_at IS NOT NULL OR NEW.reversed_by IS NOT NULL
     OR NEW.reversal_reason IS NOT NULL OR NEW.reversal_idempotency_key IS NOT NULL OR NEW.reversal_request_hash IS NOT NULL THEN
    RAISE EXCEPTION 'comisiones: un anticipo nace vigente' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('villa:advance-number:' || NEW.location_id::text, 0));
  SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM staff_advances WHERE location_id = NEW.location_id;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_advances_before_insert BEFORE INSERT ON staff_advances
  FOR EACH ROW EXECUTE FUNCTION staff_advances_before_insert();
--> statement-breakpoint
-- 3d. Solo pasan de vigente a revertida, una vez, con la reversa de SU asiento. La hora, la base.
CREATE FUNCTION commission_settlements_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_reverses bigint;
BEGIN
  IF OLD.status <> 'settled' OR NEW.status <> 'reversed' OR NEW.reversal_entry_id IS NULL
     OR (to_jsonb(NEW) - 'status' - 'reversal_entry_id' - 'reversed_at' - 'reversed_by' - 'reversal_reason'
           - 'reversal_idempotency_key' - 'reversal_request_hash')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'reversal_entry_id' - 'reversed_at' - 'reversed_by' - 'reversal_reason'
           - 'reversal_idempotency_key' - 'reversal_request_hash') THEN
    RAISE EXCEPTION 'comisiones: la liquidación % es inmutable; solo una liquidación vigente pasa a revertida, una vez', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT reverses_entry_id INTO v_reverses FROM journal_entries WHERE id = NEW.reversal_entry_id AND location_id = NEW.location_id;
  IF v_reverses IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'comisiones: la reversa de la liquidación % debe ser la reversa de su asiento', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_settlements_before_update BEFORE UPDATE ON commission_settlements
  FOR EACH ROW EXECUTE FUNCTION commission_settlements_before_update();
--> statement-breakpoint
CREATE FUNCTION staff_advances_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_reverses bigint;
BEGIN
  IF OLD.status <> 'active' OR NEW.status <> 'reversed' OR NEW.reversal_entry_id IS NULL
     OR (to_jsonb(NEW) - 'status' - 'reversal_entry_id' - 'reversed_at' - 'reversed_by' - 'reversal_reason'
           - 'reversal_idempotency_key' - 'reversal_request_hash')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'reversal_entry_id' - 'reversed_at' - 'reversed_by' - 'reversal_reason'
           - 'reversal_idempotency_key' - 'reversal_request_hash') THEN
    RAISE EXCEPTION 'comisiones: el anticipo % es inmutable; solo un anticipo vigente pasa a revertido, una vez', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT reverses_entry_id INTO v_reverses FROM journal_entries WHERE id = NEW.reversal_entry_id AND location_id = NEW.location_id;
  IF v_reverses IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'comisiones: la reversa del anticipo % debe ser la reversa de su asiento', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_advances_before_update BEFORE UPDATE ON staff_advances
  FOR EACH ROW EXECUTE FUNCTION staff_advances_before_update();
--> statement-breakpoint
-- 3e. Líneas: solo en la transacción que crea su liquidación, nacen vigentes, y las de comisión y
--     anulación cumplen las reglas de §4. Una línea solo pasa a reversed (una vez) cuando su
--     liquidación se revierte en la misma transacción.
CREATE FUNCTION commission_settlement_lines_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_staff bigint;
  v_cutoff date;
  v_created timestamptz;
  v_status text;
  v_line_staff bigint;
  v_commission bigint;
  v_sale_id bigint;
  v_sale_status text;
  v_sale_date date;
BEGIN
  SELECT staff_id, cutoff_date, created_at, status INTO v_staff, v_cutoff, v_created, v_status
    FROM commission_settlements WHERE location_id = NEW.location_id AND id = NEW.settlement_id;
  IF NOT FOUND OR v_created <> now() OR v_status <> 'settled' THEN
    RAISE EXCEPTION 'comisiones: las líneas de la liquidación % solo se registran en la transacción que la crea', NEW.settlement_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversed THEN
    RAISE EXCEPTION 'comisiones: una línea de liquidación nace vigente' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind NOT IN ('commission', 'clawback') THEN
    RETURN NEW;
  END IF;
  SELECT l.staff_id, l.commission, s.id, s.status, s.business_date
    INTO v_line_staff, v_commission, v_sale_id, v_sale_status, v_sale_date
    FROM sale_lines l JOIN sales s ON s.location_id = l.location_id AND s.id = l.sale_id
   WHERE l.location_id = NEW.location_id AND l.id = NEW.sale_line_id;
  IF v_line_staff IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'comisiones: la línea de venta % no es de la persona de la liquidación', NEW.sale_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'commission' THEN
    IF v_sale_status <> 'paid' OR v_sale_date > v_cutoff OR NEW.amount <> v_commission
       OR EXISTS (SELECT 1 FROM void_requests vr WHERE vr.location_id = NEW.location_id AND vr.sale_id = v_sale_id AND vr.status = 'pending') THEN
      RAISE EXCEPTION 'comisiones: la comisión de la línea de venta % no se puede liquidar (venta no pagada, posterior al corte, con anulación pendiente o monto distinto)',
        NEW.sale_line_id USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF v_sale_status <> 'voided' OR NEW.amount <> -v_commission OR NOT EXISTS (
      SELECT 1 FROM commission_settlement_lines c
        JOIN commission_settlements st ON st.location_id = c.location_id AND st.id = c.settlement_id
       WHERE c.location_id = NEW.location_id AND c.sale_line_id = NEW.sale_line_id AND c.kind = 'commission'
         AND NOT c.reversed AND st.status = 'settled' AND c.settlement_id <> NEW.settlement_id
    ) THEN
      RAISE EXCEPTION 'comisiones: la línea de venta % no tiene una comisión ya liquidada que descontar', NEW.sale_line_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_lines_before_insert BEFORE INSERT ON commission_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION commission_settlement_lines_before_insert();
--> statement-breakpoint
CREATE FUNCTION commission_settlement_lines_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.reversed OR NOT NEW.reversed OR (to_jsonb(NEW) - 'reversed') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed')
     OR NOT EXISTS (
       SELECT 1 FROM commission_settlements st
        WHERE st.location_id = OLD.location_id AND st.id = OLD.settlement_id AND st.status = 'reversed' AND st.reversed_at = now()
     ) THEN
    RAISE EXCEPTION 'comisiones: la línea % solo pasa a revertida con su liquidación, en la misma transacción', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_lines_before_update BEFORE UPDATE ON commission_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION commission_settlement_lines_before_update();
--> statement-breakpoint
-- 3f. Al hacer COMMIT, una liquidación nueva:
--     totales = Σ de sus líneas por tipo; su asiento es commission_payout del mismo día y sus netos
--     por cuenta son exactamente los de §3.1, sin otras cuentas; el pago de caja es un movimiento
--     de su turno; es completa (nada pendiente de la persona hasta el corte, salvo lo que espera una
--     decisión de anulación, ni anulaciones por descontar); las propinas quedan en menos de $1 si
--     las incluye, y nunca debe más de $1 de propinas; lo que debe (1365) nunca es negativo.
--     Una liquidación revertida: es la última vigente de la persona, todas sus líneas quedan
--     revertidas, el efectivo vuelve con un movimiento de reversa y 1365 sigue >= 0.
CREATE FUNCTION commission_settlements_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_c numeric; v_v numeric; v_t numeric; v_j numeric; v_d numeric; v_k numeric; v_p numeric;
  v_has_tips boolean;
  v_kind text;
  v_date date;
  v_pay_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM commission_settlements
                WHERE location_id = NEW.location_id AND staff_id = NEW.staff_id AND status = 'settled' AND number > NEW.number) THEN
      RAISE EXCEPTION 'comisiones: solo se revierte la última liquidación vigente de la persona (la % no lo es)', NEW.number
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM commission_settlement_lines
                WHERE location_id = NEW.location_id AND settlement_id = NEW.id AND NOT reversed) THEN
      RAISE EXCEPTION 'comisiones: la liquidación % se revirtió sin revertir todas sus líneas', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.paid_from = 'cash' AND NOT EXISTS (
      SELECT 1 FROM cash_movements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reversal_entry_id AND kind = 'reversal'
    ) THEN
      RAISE EXCEPTION 'comisiones: la reversa de la liquidación % de caja no devolvió el efectivo a un turno abierto', NEW.number
        USING ERRCODE = 'check_violation';
    END IF;
    IF staff_receivable(NEW.location_id, NEW.staff_id) < 0 THEN
      RAISE EXCEPTION 'comisiones: lo que debe la persona % (1365) quedaría negativo', NEW.staff_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE kind = 'commission'), 0),
         coalesce(-sum(amount) FILTER (WHERE kind = 'clawback'), 0),
         coalesce(sum(amount) FILTER (WHERE kind = 'tips'), 0),
         coalesce(sum(amount) FILTER (WHERE kind = 'adjustment'), 0),
         coalesce(-sum(amount) FILTER (WHERE kind = 'advance_deduction'), 0),
         coalesce(sum(amount) FILTER (WHERE kind = 'carry_over'), 0),
         coalesce(sum(amount), 0),
         bool_or(kind = 'tips')
    INTO v_c, v_v, v_t, v_j, v_d, v_k, v_p, v_has_tips
    FROM commission_settlement_lines WHERE location_id = NEW.location_id AND settlement_id = NEW.id;
  IF v_c <> NEW.commission_total OR v_v <> NEW.clawback_total OR v_t <> NEW.tips_total OR v_j <> NEW.adjustments_total
     OR v_d <> NEW.advance_deduction OR v_k <> NEW.carry_over OR v_p <> NEW.payout THEN
    RAISE EXCEPTION 'comisiones: los totales de la liquidación % no son la suma de sus líneas', NEW.number USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind, business_date INTO v_kind, v_date FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  v_pay_code := CASE NEW.paid_from WHEN 'cash' THEN '1105' WHEN 'bank' THEN '1110' END;
  IF v_kind IS DISTINCT FROM 'commission_payout' OR v_date IS DISTINCT FROM NEW.business_date
     OR sales_entry_net(NEW.journal_entry_id, '2335') <> NEW.commission_total - NEW.clawback_total
     OR sales_entry_net(NEW.journal_entry_id, '2380') <> NEW.tips_total
     OR sales_entry_net(NEW.journal_entry_id, '5105') <> NEW.adjustments_total
     OR sales_entry_net(NEW.journal_entry_id, '1365') <> NEW.carry_over - NEW.advance_deduction
     OR sales_entry_net(NEW.journal_entry_id, '1105') <> (CASE WHEN v_pay_code = '1105' THEN -NEW.payout ELSE 0 END)
     OR sales_entry_net(NEW.journal_entry_id, '1110') <> (CASE WHEN v_pay_code = '1110' THEN -NEW.payout ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
        WHERE l.entry_id = NEW.journal_entry_id AND a.code NOT IN ('2335', '2380', '5105', '1365', '1105', '1110')
     ) THEN
    RAISE EXCEPTION 'comisiones: el asiento de la liquidación % no coincide con sus totales', NEW.number USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.paid_from = 'cash' AND NOT EXISTS (
    SELECT 1 FROM cash_movements
     WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'commission_payout'
       AND cash_session_id = NEW.cash_session_id AND staff_id = NEW.staff_id
  ) THEN
    RAISE EXCEPTION 'comisiones: el pago de caja de la liquidación % no es un movimiento de su turno', NEW.number
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sale_lines l JOIN sales s ON s.location_id = l.location_id AND s.id = l.sale_id
     WHERE l.location_id = NEW.location_id AND l.staff_id = NEW.staff_id AND l.commission > 0
       AND s.status = 'paid' AND s.business_date <= NEW.cutoff_date
       AND NOT EXISTS (SELECT 1 FROM void_requests vr WHERE vr.location_id = s.location_id AND vr.sale_id = s.id AND vr.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM commission_settlement_lines c
                        WHERE c.location_id = l.location_id AND c.sale_line_id = l.id AND c.kind = 'commission' AND NOT c.reversed)
  ) OR EXISTS (
    SELECT 1 FROM sale_lines l JOIN sales s ON s.location_id = l.location_id AND s.id = l.sale_id
     WHERE l.location_id = NEW.location_id AND l.staff_id = NEW.staff_id AND s.status = 'voided'
       AND EXISTS (SELECT 1 FROM commission_settlement_lines c
                    WHERE c.location_id = l.location_id AND c.sale_line_id = l.id AND c.kind = 'commission' AND NOT c.reversed)
       AND NOT EXISTS (SELECT 1 FROM commission_settlement_lines c
                        WHERE c.location_id = l.location_id AND c.sale_line_id = l.id AND c.kind = 'clawback' AND NOT c.reversed)
  ) THEN
    RAISE EXCEPTION 'comisiones: la liquidación % dejó comisiones o anulaciones pendientes hasta su corte', NEW.number
      USING ERRCODE = 'check_violation';
  END IF;

  IF (v_has_tips AND abs(staff_tips_owed(NEW.location_id, NEW.staff_id)) >= 100)
     OR staff_tips_owed(NEW.location_id, NEW.staff_id) <= -100 THEN
    RAISE EXCEPTION 'comisiones: la liquidación % deja propinas pendientes de $1 o más (o sin recuperar)', NEW.number
      USING ERRCODE = 'check_violation';
  END IF;
  IF staff_receivable(NEW.location_id, NEW.staff_id) < 0 THEN
    RAISE EXCEPTION 'comisiones: lo que debe la persona % (1365) quedaría negativo', NEW.staff_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_settlements_on_insert AFTER INSERT ON commission_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_settlements_assert();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_settlements_on_reverse AFTER UPDATE ON commission_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status = 'settled' AND NEW.status = 'reversed')
  EXECUTE FUNCTION commission_settlements_assert();
--> statement-breakpoint
-- 3g. Un anticipo: su asiento es staff_advance del mismo día, 1365 por el monto contra 1105 (con su
--     movimiento de caja del turno) o 1110, sin otras cuentas. Al revertirlo, 1365 sigue >= 0 (no se
--     revierte uno ya descontado) y el efectivo vuelve a la caja.
CREATE FUNCTION staff_advances_assert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_date date;
  v_pay_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF staff_receivable(NEW.location_id, NEW.staff_id) < 0 THEN
      RAISE EXCEPTION 'comisiones: el anticipo % ya se descontó en una liquidación; revierte esa liquidación primero', NEW.number
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.paid_from = 'cash' AND NOT EXISTS (
      SELECT 1 FROM cash_movements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reversal_entry_id AND kind = 'reversal'
    ) THEN
      RAISE EXCEPTION 'comisiones: la reversa del anticipo % de caja no devolvió el efectivo a un turno abierto', NEW.number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT kind, business_date INTO v_kind, v_date FROM journal_entries WHERE id = NEW.journal_entry_id AND location_id = NEW.location_id;
  v_pay_code := CASE NEW.paid_from WHEN 'cash' THEN '1105' ELSE '1110' END;
  IF v_kind IS DISTINCT FROM 'staff_advance' OR v_date IS DISTINCT FROM NEW.business_date
     OR sales_entry_net(NEW.journal_entry_id, '1365') <> NEW.amount
     OR sales_entry_net(NEW.journal_entry_id, v_pay_code) <> -NEW.amount
     OR EXISTS (
       SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
        WHERE l.entry_id = NEW.journal_entry_id AND a.code NOT IN ('1365', v_pay_code)
     ) THEN
    RAISE EXCEPTION 'comisiones: el asiento del anticipo % no es exactamente su monto, de 1365 contra %', NEW.number,
      CASE NEW.paid_from WHEN 'cash' THEN 'la caja' ELSE 'el banco' END USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_from = 'cash' AND NOT EXISTS (
    SELECT 1 FROM cash_movements
     WHERE location_id = NEW.location_id AND journal_entry_id = NEW.journal_entry_id AND kind = 'staff_advance'
       AND cash_session_id = NEW.cash_session_id AND staff_id = NEW.staff_id
  ) THEN
    RAISE EXCEPTION 'comisiones: el anticipo de caja % no es un movimiento de su turno', NEW.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER staff_advances_on_insert AFTER INSERT ON staff_advances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION staff_advances_assert();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER staff_advances_on_reverse AFTER UPDATE ON staff_advances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status = 'reversed')
  EXECUTE FUNCTION staff_advances_assert();
--> statement-breakpoint

-- 4. Bitácora: solo-inserción; la hora la pone la base.
CREATE FUNCTION audit_events_before_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_before_insert BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_before_insert();
--> statement-breakpoint
CREATE FUNCTION audit_events_forbid_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'auditoría: % no admite %; la bitácora es solo-inserción', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_forbid_mutation();
--> statement-breakpoint

-- 5. Libro y caja.
-- 5a. Un asiento operativo tiene su fila (ahora también liquidación y anticipo: ya no se registra un
--     commission_payout suelto); la reversa de una venta, liquidación o anticipo es la anulación o
--     la reversa de esa fila.
CREATE OR REPLACE FUNCTION ledger_assert_operational_row() RETURNS trigger LANGUAGE plpgsql
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
    WHEN 'commission_payout' THEN EXISTS (
      SELECT 1 FROM commission_settlements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id)
    WHEN 'staff_advance' THEN EXISTS (
      SELECT 1 FROM staff_advances WHERE location_id = NEW.location_id AND journal_entry_id = NEW.id)
    WHEN 'reversal' THEN
      (NOT EXISTS (SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id)
       OR EXISTS (
         SELECT 1 FROM sales WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id AND void_entry_id = NEW.id))
      AND (NOT EXISTS (SELECT 1 FROM commission_settlements WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id)
       OR EXISTS (
         SELECT 1 FROM commission_settlements
          WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id AND reversal_entry_id = NEW.id))
      AND (NOT EXISTS (SELECT 1 FROM staff_advances WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id)
       OR EXISTS (
         SELECT 1 FROM staff_advances
          WHERE location_id = NEW.location_id AND journal_entry_id = NEW.reverses_entry_id AND reversal_entry_id = NEW.id))
    ELSE true
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'ledger: el asiento % (%) no tiene su registro operativo (venta, gasto, movimiento de caja, liquidación o anticipo)',
      NEW.id, NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER journal_entries_operational_row ON journal_entries;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_operational_row AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind IN ('sale', 'expense', 'tip_payout', 'cash_deposit', 'commission_payout', 'staff_advance', 'reversal'))
  EXECUTE FUNCTION ledger_assert_operational_row();
--> statement-breakpoint
-- 5b. Un movimiento de caja: su asiento es de su mismo tipo y mueve efectivo en el sentido del tipo
--     (la venta entra; el gasto, las propinas, la consignación, la liquidación y el anticipo salen;
--     la reversa, en sentido CONTRARIO al asiento que reversa), por el monto de su fila.
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
     OR (NEW.kind IN ('expense', 'tip_payout', 'cash_deposit', 'commission_payout', 'staff_advance') AND v_cash > 0)
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

-- 5b. Supresión a solicitud del titular (Ley 1581; docs/sprint-5-comisiones-informes.md §12.8).
--     Los datos personales salen; lo contable se queda. Cada tabla solo-inserción admite un único
--     cambio más: su texto libre pasa a vacío, y solo si el cliente ya está anonimizado. El libro
--     (asientos y líneas) no se toca: nunca recibe el motivo de una anulación desde este sprint, y
--     los memos anteriores no se exportan ni tienen visor.
CREATE OR REPLACE FUNCTION agenda_before_update_appointment() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed appointments;
BEGIN
  -- Antes que el resto: la cita de un cliente suprimido puede estar terminada o cancelada.
  scrubbed := OLD;
  scrubbed.notes := NULL;
  scrubbed.cancel_note := NULL;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND villa_client_anonymized(OLD.location_id, OLD.client_id) THEN
    RETURN NEW;
  END IF;

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
DROP TRIGGER appointment_events_append_only ON appointment_events;
--> statement-breakpoint
CREATE TRIGGER appointment_events_no_delete BEFORE DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION agenda_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION appointment_events_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed appointment_events;
BEGIN
  scrubbed := OLD;
  scrubbed.reason := NULL;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND EXISTS (
    SELECT 1 FROM appointments a
     WHERE a.location_id = OLD.location_id AND a.id = OLD.appointment_id AND villa_client_anonymized(a.location_id, a.client_id)
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agenda: % no admite %; cancela o registra un cambio nuevo', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_events_before_update BEFORE UPDATE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION appointment_events_before_update();
--> statement-breakpoint
DROP TRIGGER client_consents_append_only ON client_consents;
--> statement-breakpoint
CREATE TRIGGER client_consents_no_delete BEFORE DELETE ON client_consents
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
-- La IP y el navegador salen; qué aceptó, de qué versión y cuándo se queda como prueba del consentimiento.
CREATE OR REPLACE FUNCTION client_consents_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed client_consents;
BEGIN
  scrubbed := OLD;
  scrubbed.ip := NULL;
  scrubbed.user_agent := NULL;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND villa_client_anonymized(OLD.location_id, OLD.client_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserva: % no admite %; registra una fila nueva', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER client_consents_before_update BEFORE UPDATE ON client_consents
  FOR EACH ROW EXECUTE FUNCTION client_consents_before_update();
--> statement-breakpoint
DROP TRIGGER notification_events_append_only ON notification_events;
--> statement-breakpoint
CREATE TRIGGER notification_events_no_delete BEFORE DELETE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notification_events_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed notification_events;
BEGIN
  scrubbed := OLD;
  scrubbed.error_detail := NULL;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND EXISTS (
    SELECT 1 FROM notifications n
     WHERE n.location_id = OLD.location_id AND n.id = OLD.notification_id AND villa_client_anonymized(n.location_id, n.client_id)
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserva: % no admite %; registra una fila nueva', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notification_events_before_update BEFORE UPDATE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION notification_events_before_update();
--> statement-breakpoint
-- El motivo de una anulación es texto libre inmutable: para un cliente suprimido se reemplaza por una
-- marca fija (el CHECK exige un motivo). Así no llega a ningún visor ni archivo. Misma función de
-- 0011 con la excepción al inicio.
CREATE OR REPLACE FUNCTION void_requests_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed void_requests;
BEGIN
  scrubbed := OLD;
  scrubbed.reason := '[suprimido]';
  scrubbed.decision_note := CASE WHEN OLD.decision_note IS NULL THEN NULL ELSE '[suprimido]' END;
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND EXISTS (
    SELECT 1 FROM sales s
     WHERE s.location_id = OLD.location_id AND s.id = OLD.sale_id AND villa_client_anonymized(s.location_id, s.client_id)
  ) THEN
    RETURN NEW;
  END IF;

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
DROP TRIGGER cash_movements_append_only ON cash_movements;
--> statement-breakpoint
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
-- El movimiento de caja de una anulación copia el motivo en su descripción. El monto no se toca.
CREATE OR REPLACE FUNCTION cash_movements_before_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scrubbed cash_movements;
BEGIN
  scrubbed := OLD;
  scrubbed.description := 'Anulación: [suprimido]';
  IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM scrubbed AND OLD.kind = 'reversal' AND EXISTS (
    SELECT 1
      FROM journal_entries r
      JOIN sales s ON s.location_id = r.location_id AND s.journal_entry_id = r.reverses_entry_id
     WHERE r.location_id = OLD.location_id AND r.id = OLD.journal_entry_id AND villa_client_anonymized(s.location_id, s.client_id)
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cobro: % no admite %; corrige con un registro nuevo', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_movements_before_update BEFORE UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION cash_movements_before_update();
--> statement-breakpoint
-- Se puede repetir sobre el mismo cliente: así se vuelve a aplicar tras restaurar una copia anterior
-- (docs/despliegue.md §11). La regla de negocio (citas activas, permiso, bitácora) está en la app.
CREATE OR REPLACE FUNCTION erase_client_personal_data(p_location_id bigint, p_client_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE clients
     SET name = 'Anónimo', phone_e164 = NULL, email = NULL, anonymized_at = coalesce(anonymized_at, now()), updated_at = now()
   WHERE location_id = p_location_id AND id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clientes: el cliente % no existe en la sede %', p_client_id, p_location_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE appointments
     SET notes = NULL, cancel_note = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id AND (notes IS NOT NULL OR cancel_note IS NOT NULL);

  UPDATE appointment_events e
     SET reason = NULL
    FROM appointments a
   WHERE e.location_id = p_location_id AND a.location_id = e.location_id AND a.id = e.appointment_id
     AND a.client_id = p_client_id AND e.reason IS NOT NULL;

  UPDATE appointment_links l
     SET revoked_at = now(), revoked_reason = 'staff'
    FROM appointments a
   WHERE l.location_id = p_location_id AND a.location_id = l.location_id AND a.id = l.appointment_id
     AND a.client_id = p_client_id AND l.revoked_at IS NULL;

  UPDATE booking_verifications
     SET consent_ip = NULL, consent_user_agent = NULL, contact_name = NULL, contact_email = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id
     AND (consent_ip IS NOT NULL OR consent_user_agent IS NOT NULL OR contact_name IS NOT NULL OR contact_email IS NOT NULL);

  UPDATE client_consents
     SET ip = NULL, user_agent = NULL
   WHERE location_id = p_location_id AND client_id = p_client_id AND (ip IS NOT NULL OR user_agent IS NOT NULL);

  UPDATE notifications
     SET params = '{}'::jsonb
   WHERE location_id = p_location_id AND client_id = p_client_id AND params <> '{}'::jsonb;

  UPDATE notification_events e
     SET error_detail = NULL
    FROM notifications n
   WHERE e.location_id = p_location_id AND n.location_id = e.location_id AND n.id = e.notification_id
     AND n.client_id = p_client_id AND e.error_detail IS NOT NULL;

  UPDATE void_requests v
     SET reason = '[suprimido]', decision_note = CASE WHEN v.decision_note IS NULL THEN NULL ELSE '[suprimido]' END
    FROM sales s
   WHERE v.location_id = p_location_id AND s.location_id = v.location_id AND s.id = v.sale_id
     AND s.client_id = p_client_id AND v.reason <> '[suprimido]';

  UPDATE cash_movements m
     SET description = 'Anulación: [suprimido]'
    FROM journal_entries r
    JOIN sales s ON s.location_id = r.location_id AND s.journal_entry_id = r.reverses_entry_id
   WHERE m.location_id = p_location_id AND m.kind = 'reversal' AND r.location_id = m.location_id AND r.id = m.journal_entry_id
     AND s.client_id = p_client_id AND m.description <> 'Anulación: [suprimido]';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_client_personal_data(bigint, bigint) FROM PUBLIC;
--> statement-breakpoint
-- Si alguien migró como superusuario, la función SECURITY DEFINER no debe correr como tal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_owner') AND current_user <> 'villa_owner' THEN
    EXECUTE 'ALTER FUNCTION erase_client_personal_data(bigint, bigint) OWNER TO villa_owner';
  END IF;
END;
$$;
--> statement-breakpoint

-- 6. Permisos de villa_app: los de 0012 más el paso a revertida de liquidaciones, líneas y
--    anticipos. audit_events: solo SELECT e INSERT. Una migración que redefina esta función debe
--    partir de ESTA versión.
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
  -- cash_movements, expenses, personal_data_reads, audit_events.
  FOREACH t IN ARRAY ARRAY[
    'locations', 'user', 'session', 'account', 'verification', 'two_factor', 'staff_members', 'services',
    'staff_schedules', 'clients', 'appointments', 'time_off', 'booking_verifications', 'appointment_links',
    'rate_limit_counters', 'login_throttles'
  ] LOOP
    EXECUTE format('GRANT UPDATE ON %I TO villa_app', t);
  END LOOP;
  -- Solo las columnas que cambian: editar un medio de pago o una categoría, anular una venta,
  -- cerrar un turno y darlo por revisado, decidir una solicitud, marcar un aviso como entregado,
  -- revertir una liquidación (y sus líneas) o un anticipo.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash, reviewed_by) ON cash_sessions TO villa_app';
  EXECUTE 'GRANT UPDATE (status, decided_by, decided_at, decision_note, decision_idempotency_key, decision_request_hash)
    ON void_requests TO villa_app';
  EXECUTE 'GRANT UPDATE (notified_at, occurrences, failures, locked_until) ON security_alerts TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON commission_settlements TO villa_app';
  EXECUTE 'GRANT UPDATE (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key,
    reversal_request_hash) ON staff_advances TO villa_app';
  EXECUTE 'GRANT UPDATE (reversed) ON commission_settlement_lines TO villa_app';
  -- DELETE solo en lo efímero: sesiones y verificaciones de better-auth, el horario semanal
  -- (se reemplaza completo), los contadores de límites y los avisos de seguridad ya entregados.
  FOREACH t IN ARRAY ARRAY[
    'session', 'verification', 'two_factor', 'staff_schedules', 'rate_limit_counters', 'login_throttles', 'security_alerts'
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
