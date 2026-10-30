CREATE TABLE "cash_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cash_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"cash_session_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"staff_id" bigint,
	"description" text NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "cash_movements_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('sale','expense','tip_payout','cash_deposit','reversal')),
	CONSTRAINT "cash_movements_staff_check" CHECK (("cash_movements"."kind" = 'tip_payout') = ("cash_movements"."staff_id" is not null)),
	CONSTRAINT "cash_movements_hash_check" CHECK (("cash_movements"."idempotency_key" is null) = ("cash_movements"."request_hash" is null) and ("cash_movements"."request_hash" is null or "cash_movements"."request_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cash_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_counted" bigint NOT NULL,
	"opening_expected" bigint NOT NULL,
	"opening_note" text,
	"opening_entry_id" bigint,
	"open_idempotency_key" text NOT NULL,
	"open_request_hash" text NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"closing_counted" bigint,
	"expected_cash" bigint,
	"difference" bigint,
	"note" text,
	"closing_entry_id" bigint,
	"close_idempotency_key" text,
	"close_request_hash" text,
	CONSTRAINT "cash_sessions_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "cash_sessions_open_idempotency_key" UNIQUE("location_id","open_idempotency_key"),
	CONSTRAINT "cash_sessions_close_idempotency_key" UNIQUE("location_id","close_idempotency_key"),
	CONSTRAINT "cash_sessions_amounts_check" CHECK ("cash_sessions"."opening_counted" >= 0 and "cash_sessions"."closing_counted" >= 0),
	CONSTRAINT "cash_sessions_opening_check" CHECK (("cash_sessions"."opening_counted" = "cash_sessions"."opening_expected") = ("cash_sessions"."opening_entry_id" is null)
        and ("cash_sessions"."opening_counted" = "cash_sessions"."opening_expected" or length(trim("cash_sessions"."opening_note")) > 0)),
	CONSTRAINT "cash_sessions_open_hash_check" CHECK ("cash_sessions"."open_request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cash_sessions_closed_check" CHECK (("cash_sessions"."closed_at" is null) = ("cash_sessions"."closed_by" is null)
        and ("cash_sessions"."closed_at" is null) = ("cash_sessions"."closing_counted" is null)
        and ("cash_sessions"."closed_at" is null) = ("cash_sessions"."expected_cash" is null)
        and ("cash_sessions"."closed_at" is null) = ("cash_sessions"."difference" is null)
        and ("cash_sessions"."closed_at" is null) = ("cash_sessions"."close_idempotency_key" is null)
        and ("cash_sessions"."closed_at" is null) = ("cash_sessions"."close_request_hash" is null)),
	CONSTRAINT "cash_sessions_difference_check" CHECK ("cash_sessions"."difference" is null or ("cash_sessions"."difference" = "cash_sessions"."closing_counted" - "cash_sessions"."expected_cash"
        and ("cash_sessions"."difference" = 0) = ("cash_sessions"."closing_entry_id" is null)
        and ("cash_sessions"."difference" = 0 or length(trim("cash_sessions"."note")) > 0)))
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "expense_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"name" text NOT NULL,
	"account_code" text DEFAULT '5195' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "expense_categories_account_check" CHECK ("expense_categories"."account_code" in ('5195')),
	CONSTRAINT "expense_categories_name_check" CHECK (length(trim("expense_categories"."name")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "expenses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"paid_from" text NOT NULL,
	"cash_session_id" bigint,
	"description" text NOT NULL,
	"business_date" date NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "expenses_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" > 0),
	CONSTRAINT "expenses_paid_from_check" CHECK ("expenses"."paid_from" in ('cash','bank') and ("expenses"."paid_from" = 'cash') = ("expenses"."cash_session_id" is not null)),
	CONSTRAINT "expenses_description_check" CHECK (length(trim("expenses"."description")) between 1 and 200),
	CONSTRAINT "expenses_request_hash_check" CHECK ("expenses"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_methods_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "payment_methods_kind_check" CHECK ("payment_methods"."kind" in ('cash','card','transfer','wallet')),
	CONSTRAINT "payment_methods_fee_check" CHECK ("payment_methods"."fee_bps" between 0 and 9999),
	CONSTRAINT "payment_methods_cash_check" CHECK ("payment_methods"."kind" <> 'cash' or ("payment_methods"."fee_bps" = 0 and "payment_methods"."active")),
	CONSTRAINT "payment_methods_label_check" CHECK (length(trim("payment_methods"."label")) between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sale_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"sale_id" bigint NOT NULL,
	"position" smallint NOT NULL,
	"kind" text DEFAULT 'service' NOT NULL,
	"service_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"description" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"discount" bigint NOT NULL,
	"discount_reason" text,
	"net" bigint NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission" bigint NOT NULL,
	CONSTRAINT "sale_lines_position_key" UNIQUE("sale_id","position"),
	CONSTRAINT "sale_lines_kind_check" CHECK ("sale_lines"."kind" in ('service')),
	CONSTRAINT "sale_lines_amounts_check" CHECK ("sale_lines"."unit_price" >= 0 and "sale_lines"."discount" >= 0 and "sale_lines"."discount" <= "sale_lines"."unit_price" and "sale_lines"."net" = "sale_lines"."unit_price" - "sale_lines"."discount"
        and "sale_lines"."commission" >= 0 and "sale_lines"."commission_bps" between 0 and 10000),
	CONSTRAINT "sale_lines_discount_reason_check" CHECK ("sale_lines"."discount" = 0 or length(trim("sale_lines"."discount_reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sale_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"sale_id" bigint NOT NULL,
	"method_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"amount" bigint NOT NULL,
	"tendered" bigint,
	"change" bigint,
	"fee" bigint NOT NULL,
	CONSTRAINT "sale_payments_method_key" UNIQUE("sale_id","method_id"),
	CONSTRAINT "sale_payments_kind_check" CHECK ("sale_payments"."kind" in ('cash','card','transfer','wallet')),
	CONSTRAINT "sale_payments_amounts_check" CHECK ("sale_payments"."amount" > 0 and "sale_payments"."fee" >= 0 and "sale_payments"."fee" < "sale_payments"."amount" and "sale_payments"."fee_bps" between 0 and 9999),
	CONSTRAINT "sale_payments_cash_check" CHECK (case when "sale_payments"."kind" = 'cash'
        then "sale_payments"."tendered" is not null and "sale_payments"."change" is not null and "sale_payments"."change" >= 0 and "sale_payments"."tendered" - "sale_payments"."change" = "sale_payments"."amount" and "sale_payments"."fee" = 0
        else "sale_payments"."tendered" is null and "sale_payments"."change" is null end)
);
--> statement-breakpoint
CREATE TABLE "sale_tips" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sale_tips_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"sale_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"fee_share" bigint NOT NULL,
	"payable" bigint NOT NULL,
	CONSTRAINT "sale_tips_staff_key" UNIQUE("sale_id","staff_id"),
	CONSTRAINT "sale_tips_amounts_check" CHECK ("sale_tips"."amount" > 0 and "sale_tips"."fee_share" >= 0 and "sale_tips"."payable" > 0 and "sale_tips"."payable" = "sale_tips"."amount" - "sale_tips"."fee_share")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sales_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"public_id" text NOT NULL,
	"appointment_id" bigint,
	"client_id" bigint,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"journal_entry_id" bigint NOT NULL,
	"void_entry_id" bigint,
	"voided_at" timestamp with time zone,
	"subtotal" bigint NOT NULL,
	"discount" bigint NOT NULL,
	"tips" bigint NOT NULL,
	"total_paid" bigint NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "sales_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "sales_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "sales_journal_entry_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "sales_void_entry_key" UNIQUE("void_entry_id"),
	CONSTRAINT "sales_status_check" CHECK ("sales"."status" in ('paid','voided')),
	CONSTRAINT "sales_voided_check" CHECK (("sales"."status" = 'voided') = ("sales"."void_entry_id" is not null) and ("sales"."status" = 'voided') = ("sales"."voided_at" is not null)),
	CONSTRAINT "sales_amounts_check" CHECK ("sales"."subtotal" >= 0 and "sales"."discount" >= 0 and "sales"."tips" >= 0 and "sales"."total_paid" > 0 and "sales"."discount" <= "sales"."subtotal"
        and "sales"."total_paid" = "sales"."subtotal" - "sales"."discount" + "sales"."tips"),
	CONSTRAINT "sales_request_hash_check" CHECK ("sales"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "void_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "void_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"sale_id" bigint NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"decision_idempotency_key" text,
	"decision_request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "void_requests_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "void_requests_decision_idempotency_key" UNIQUE("location_id","decision_idempotency_key"),
	CONSTRAINT "void_requests_status_check" CHECK ("void_requests"."status" in ('pending','approved','rejected')),
	CONSTRAINT "void_requests_reason_check" CHECK (length(trim("void_requests"."reason")) between 1 and 300),
	CONSTRAINT "void_requests_decided_check" CHECK (("void_requests"."status" = 'pending') = ("void_requests"."decided_by" is null) and ("void_requests"."status" = 'pending') = ("void_requests"."decided_at" is null)
        and ("void_requests"."status" = 'pending') = ("void_requests"."decision_idempotency_key" is null) and ("void_requests"."status" = 'pending') = ("void_requests"."decision_request_hash" is null)
        and ("void_requests"."status" <> 'rejected' or length(trim("void_requests"."decision_note")) > 0)),
	CONSTRAINT "void_requests_request_hash_check" CHECK ("void_requests"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_kind_check";--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "commission_base" text DEFAULT 'net' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "max_discount_bps" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "reception_can_discount" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "tips_bear_card_fees" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opening_entry_fk" FOREIGN KEY ("location_id","opening_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closing_entry_fk" FOREIGN KEY ("location_id","closing_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_account_fk" FOREIGN KEY ("location_id","account_code") REFERENCES "public"."accounts"("location_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("location_id","category_id") REFERENCES "public"."expense_categories"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_session_fk" FOREIGN KEY ("location_id","cash_session_id") REFERENCES "public"."cash_sessions"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_journal_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_fk" FOREIGN KEY ("location_id","sale_id") REFERENCES "public"."sales"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_service_fk" FOREIGN KEY ("location_id","service_id") REFERENCES "public"."services"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_fk" FOREIGN KEY ("location_id","sale_id") REFERENCES "public"."sales"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_fk" FOREIGN KEY ("location_id","method_id") REFERENCES "public"."payment_methods"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tips" ADD CONSTRAINT "sale_tips_sale_fk" FOREIGN KEY ("location_id","sale_id") REFERENCES "public"."sales"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tips" ADD CONSTRAINT "sale_tips_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_journal_entry_fk" FOREIGN KEY ("location_id","journal_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_void_entry_fk" FOREIGN KEY ("location_id","void_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "void_requests" ADD CONSTRAINT "void_requests_sale_fk" FOREIGN KEY ("location_id","sale_id") REFERENCES "public"."sales"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_session_idx" ON "cash_movements" USING btree ("cash_session_id");--> statement-breakpoint
CREATE INDEX "cash_movements_staff_idx" ON "cash_movements" USING btree ("location_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open" ON "cash_sessions" USING btree ("location_id") WHERE "cash_sessions"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_location_name_key" ON "expense_categories" USING btree ("location_id",lower("name"));--> statement-breakpoint
CREATE INDEX "expenses_location_date_idx" ON "expenses" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_location_label_key" ON "payment_methods" USING btree ("location_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_one_cash" ON "payment_methods" USING btree ("location_id") WHERE "payment_methods"."kind" = 'cash';--> statement-breakpoint
CREATE INDEX "sale_lines_staff_idx" ON "sale_lines" USING btree ("location_id","staff_id");--> statement-breakpoint
CREATE INDEX "sale_tips_staff_idx" ON "sale_tips" USING btree ("location_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_one_paid_per_appointment" ON "sales" USING btree ("appointment_id") WHERE "sales"."status" = 'paid';--> statement-breakpoint
CREATE INDEX "sales_location_date_idx" ON "sales" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "void_requests_one_pending" ON "void_requests" USING btree ("sale_id") WHERE "void_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "void_requests_one_approved" ON "void_requests" USING btree ("sale_id") WHERE "void_requests"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "void_requests_location_status_idx" ON "void_requests" USING btree ("location_id","status","id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal'));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_commission_base_check" CHECK ("locations"."commission_base" in ('net','gross'));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_max_discount_bps_check" CHECK ("locations"."max_discount_bps" between 0 and 10000);--> statement-breakpoint

-- ─── A mano: garantías de cobro, caja y gastos (docs/sprint-4-cobro-caja.md §2–§5) ───────────
-- La app decide el flujo; la base asegura lo que no puede fallar aunque la app tenga un error:
--   1. Medios de pago y categorías iniciales en las sedes que ya existen.
--   2. Solo-inserción: líneas, pagos y propinas de la venta, movimientos de caja y gastos.
--   3. Una venta pagada solo pasa a anulada, una vez, con la reversa exacta de su asiento.
--   4. Los totales de la venta = la suma de sus filas = lo que dice su asiento (al hacer COMMIT).
--   5. Una caja abierta solo pasa a cerrada, una vez; el efectivo solo entra a una caja abierta.
--   6. Una solicitud de anulación se decide una sola vez.
--   7. No se cierra el día contable con una caja abierta.
--   8. Permisos de villa_app: UPDATE solo en las columnas que la app cambia.

-- 1. Datos iniciales (createLocation hace lo mismo para las sedes nuevas: src/domain/sales/defaults.ts).
INSERT INTO payment_methods (location_id, kind, label, fee_bps)
SELECT l.id, m.kind, m.label, 0
  FROM locations l
 CROSS JOIN (VALUES (1, 'cash', 'Efectivo'), (2, 'card', 'Tarjeta'), (3, 'transfer', 'Transferencia'), (4, 'wallet', 'Nequi/Daviplata'))
       AS m(ord, kind, label)
 WHERE NOT EXISTS (SELECT 1 FROM payment_methods p WHERE p.location_id = l.id)
 ORDER BY l.id, m.ord;
--> statement-breakpoint
INSERT INTO expense_categories (location_id, name, account_code)
SELECT l.id, c.name, '5195'
  FROM locations l
 CROSS JOIN (VALUES (1, 'Arriendo'), (2, 'Servicios públicos'), (3, 'Insumos'), (4, 'Aseo'), (5, 'Mantenimiento'), (6, 'Publicidad'), (7, 'Otros'))
       AS c(ord, name)
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories e WHERE e.location_id = l.id)
   AND EXISTS (SELECT 1 FROM accounts a WHERE a.location_id = l.id AND a.code = '5195')
 ORDER BY l.id, c.ord;
--> statement-breakpoint

-- 2. Solo-inserción.
CREATE FUNCTION sales_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cobro: % no admite %; corrige con una anulación o un registro nuevo', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sale_lines_append_only BEFORE UPDATE OR DELETE ON sale_lines FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_lines_no_truncate BEFORE TRUNCATE ON sale_lines FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_payments_append_only BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_payments_no_truncate BEFORE TRUNCATE ON sale_payments FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_tips_append_only BEFORE UPDATE OR DELETE ON sale_tips FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_tips_no_truncate BEFORE TRUNCATE ON sale_tips FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_movements_no_truncate BEFORE TRUNCATE ON cash_movements FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER expenses_append_only BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
-- Las demás tablas nuevas se actualizan (con reglas abajo) pero nunca se borran.
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER sales_no_truncate BEFORE TRUNCATE ON sales FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_sessions_no_delete BEFORE DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_sessions_no_truncate BEFORE TRUNCATE ON cash_sessions FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER void_requests_no_delete BEFORE DELETE ON void_requests FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER void_requests_no_truncate BEFORE TRUNCATE ON void_requests FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_methods_no_delete BEFORE DELETE ON payment_methods FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_methods_no_truncate BEFORE TRUNCATE ON payment_methods FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER expense_categories_no_delete BEFORE DELETE ON expense_categories FOR EACH ROW EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER expense_categories_no_truncate BEFORE TRUNCATE ON expense_categories FOR EACH STATEMENT EXECUTE FUNCTION sales_forbid_mutation();
--> statement-breakpoint

-- Un medio de pago no cambia de sede ni de tipo (las ventas pasadas copian tipo, nombre y costo).
CREATE FUNCTION payment_methods_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'cobro: el medio de pago % no cambia de sede ni de tipo', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_methods_before_update BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION payment_methods_before_update();
--> statement-breakpoint
CREATE FUNCTION expense_categories_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'gastos: la categoría % no cambia de sede', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_categories_before_update BEFORE UPDATE ON expense_categories FOR EACH ROW EXECUTE FUNCTION expense_categories_before_update();
--> statement-breakpoint

-- 3. La venta: nace pagada y en esta transacción; solo pasa a anulada con la reversa de su asiento.
CREATE FUNCTION sales_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- La hora la pone la base: las filas hijas solo se agregan en la misma transacción (abajo).
  NEW.created_at := now();
  IF NEW.status <> 'paid' OR NEW.void_entry_id IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'cobro: una venta nace pagada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_before_insert BEFORE INSERT ON sales FOR EACH ROW EXECUTE FUNCTION sales_before_insert();
--> statement-breakpoint
CREATE FUNCTION sales_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_before_update BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION sales_before_update();
--> statement-breakpoint
CREATE FUNCTION sales_child_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sales WHERE id = NEW.sale_id AND location_id = NEW.location_id AND created_at = now() AND status = 'paid'
  ) THEN
    RAISE EXCEPTION 'cobro: la venta % ya está registrada; no admite filas nuevas en %', NEW.sale_id, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sale_lines_before_insert BEFORE INSERT ON sale_lines FOR EACH ROW EXECUTE FUNCTION sales_child_before_insert();
--> statement-breakpoint
CREATE TRIGGER sale_payments_before_insert BEFORE INSERT ON sale_payments FOR EACH ROW EXECUTE FUNCTION sales_child_before_insert();
--> statement-breakpoint
CREATE TRIGGER sale_tips_before_insert BEFORE INSERT ON sale_tips FOR EACH ROW EXECUTE FUNCTION sales_child_before_insert();
--> statement-breakpoint

-- 4. Al hacer COMMIT: totales = suma de las filas, y el asiento dice exactamente lo mismo.
CREATE FUNCTION sales_entry_net(p_entry_id bigint, p_code text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
   WHERE l.entry_id = p_entry_id AND a.code = p_code
$$;
--> statement-breakpoint
CREATE FUNCTION sales_assert_totals(p_sale_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s sales%ROWTYPE;
  v_lines bigint; v_subtotal numeric; v_discount numeric; v_net numeric; v_commission numeric;
  v_tips numeric; v_payable numeric;
  v_paid numeric; v_cash numeric; v_electronic numeric; v_fees numeric;
  v_kind text;
BEGIN
  SELECT * INTO s FROM sales WHERE id = p_sale_id;
  SELECT count(*), coalesce(sum(unit_price), 0), coalesce(sum(discount), 0), coalesce(sum(net), 0), coalesce(sum(commission), 0)
    INTO v_lines, v_subtotal, v_discount, v_net, v_commission FROM sale_lines WHERE sale_id = p_sale_id;
  SELECT coalesce(sum(amount), 0), coalesce(sum(payable), 0) INTO v_tips, v_payable FROM sale_tips WHERE sale_id = p_sale_id;
  SELECT coalesce(sum(amount), 0), coalesce(sum(amount) FILTER (WHERE kind = 'cash'), 0),
         coalesce(sum(amount) FILTER (WHERE kind <> 'cash'), 0), coalesce(sum(fee), 0)
    INTO v_paid, v_cash, v_electronic, v_fees FROM sale_payments WHERE sale_id = p_sale_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'cobro: la venta % no tiene líneas', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_subtotal <> s.subtotal OR v_discount <> s.discount OR v_tips <> s.tips OR v_paid <> s.total_paid THEN
    RAISE EXCEPTION 'cobro: los totales de la venta % no son la suma de sus líneas, propinas y pagos', p_sale_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind INTO v_kind FROM journal_entries WHERE id = s.journal_entry_id AND location_id = s.location_id;
  IF v_kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'cobro: el asiento de la venta % no es un asiento de venta', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
  IF sales_entry_net(s.journal_entry_id, '1105') <> v_cash
     OR sales_entry_net(s.journal_entry_id, '1110') <> v_electronic - v_fees
     OR sales_entry_net(s.journal_entry_id, '5305') <> v_fees - (v_tips - v_payable)
     OR sales_entry_net(s.journal_entry_id, '4170') <> -v_net
     OR sales_entry_net(s.journal_entry_id, '2380') <> -v_payable
     OR sales_entry_net(s.journal_entry_id, '5105') <> v_commission
     OR sales_entry_net(s.journal_entry_id, '2335') <> -v_commission THEN
    RAISE EXCEPTION 'cobro: el asiento de la venta % no coincide con sus líneas, propinas y pagos', p_sale_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- El efectivo solo entra a una caja abierta: la venta queda como movimiento de ese turno.
  IF v_cash > 0 AND NOT EXISTS (SELECT 1 FROM cash_movements WHERE journal_entry_id = s.journal_entry_id AND kind = 'sale') THEN
    RAISE EXCEPTION 'cobro: la venta % recibe efectivo sin caja abierta', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sales_check_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sales_assert_totals(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_totals AFTER INSERT ON sales
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_check_totals();
--> statement-breakpoint

-- 5. Caja: nace abierta; solo se cierra, una vez, sin tocar la apertura.
CREATE FUNCTION cash_sessions_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.opened_at := now();
  IF NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'caja: un turno nace abierto' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_sessions_before_insert BEFORE INSERT ON cash_sessions FOR EACH ROW EXECUTE FUNCTION cash_sessions_before_insert();
--> statement-breakpoint
CREATE FUNCTION cash_sessions_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
     OR (to_jsonb(NEW) - 'closed_by' - 'closed_at' - 'closing_counted' - 'expected_cash' - 'difference' - 'note'
           - 'closing_entry_id' - 'close_idempotency_key' - 'close_request_hash')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'closed_by' - 'closed_at' - 'closing_counted' - 'expected_cash' - 'difference' - 'note'
           - 'closing_entry_id' - 'close_idempotency_key' - 'close_request_hash') THEN
    RAISE EXCEPTION 'caja: el turno % solo pasa de abierto a cerrado, una vez', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_sessions_before_update BEFORE UPDATE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION cash_sessions_before_update();
--> statement-breakpoint
CREATE FUNCTION cash_requires_open_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cash_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cash_sessions WHERE id = NEW.cash_session_id AND location_id = NEW.location_id AND closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'caja: el turno % no está abierto; el efectivo solo se mueve con la caja abierta', NEW.cash_session_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_movements_open_session BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint
CREATE TRIGGER expenses_open_session BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION cash_requires_open_session();
--> statement-breakpoint

-- 6. Solicitud de anulación: nace pendiente y se decide una vez; lo pedido no se edita.
CREATE FUNCTION void_requests_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'anulación: una solicitud nace pendiente' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER void_requests_before_insert BEFORE INSERT ON void_requests FOR EACH ROW EXECUTE FUNCTION void_requests_before_insert();
--> statement-breakpoint
CREATE FUNCTION void_requests_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER void_requests_before_update BEFORE UPDATE ON void_requests FOR EACH ROW EXECUTE FUNCTION void_requests_before_update();
--> statement-breakpoint

-- 7. El día contable no se cierra con una caja abierta (§4).
CREATE FUNCTION day_close_requires_closed_cash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'close' AND EXISTS (SELECT 1 FROM cash_sessions WHERE location_id = NEW.location_id AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'ledger: cierra la caja antes de cerrar el día %', NEW.business_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER day_close_events_cash_closed BEFORE INSERT ON day_close_events FOR EACH ROW EXECUTE FUNCTION day_close_requires_closed_cash();
--> statement-breakpoint

-- 8. Permisos de villa_app (misma función de 0009 con las tablas del sprint 4). Las tablas
-- solo-inserción nuevas (sale_lines, sale_payments, sale_tips, cash_movements, expenses) quedan
-- con SELECT e INSERT. En sales, cash_sessions y void_requests solo las columnas que cambian.
CREATE OR REPLACE FUNCTION app_apply_grants() RETURNS void LANGUAGE plpgsql AS $$
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
  -- cerrar un turno, decidir una solicitud.
  EXECUTE 'GRANT UPDATE (label, fee_bps, active, updated_at) ON payment_methods TO villa_app';
  EXECUTE 'GRANT UPDATE (name, account_code, active, updated_at) ON expense_categories TO villa_app';
  EXECUTE 'GRANT UPDATE (status, void_entry_id, voided_at) ON sales TO villa_app';
  EXECUTE 'GRANT UPDATE (closed_by, closed_at, closing_counted, expected_cash, difference, note, closing_entry_id,
    close_idempotency_key, close_request_hash) ON cash_sessions TO villa_app';
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
SELECT app_apply_grants();
