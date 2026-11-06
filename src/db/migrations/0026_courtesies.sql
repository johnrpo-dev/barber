-- Sprint 8, parte E: cortesías (docs/sprint-8-gastos-controles.md §4).
-- Una cita atendida que el negocio regala NO es una venta de $0 (eso obligaría a volver opcional el
-- asiento de la venta y a tocar sales_assert_totals, la anulación y los triggers del cobro): es un
-- registro aparte, sin asiento contable, sin comisión y sin medio de pago.
-- 1. appointment_courtesies: una por cita (UNIQUE location_id, appointment_id), FK compuestas a la
--    cita y a quien la atendió, precio de lista congelado en pesos enteros, motivo de una línea de 3 a
--    300 caracteres y el día contable local. Solo-inserción para la app: app_apply_grants le da
--    SELECT e INSERT y nada más (no está en ninguna lista de UPDATE ni de DELETE).
-- 2. Evento nuevo en la bitácora: appointment.courtesy (finanzas). Sin datos del cliente.
-- Las reglas (quién, que la cita no tenga venta ni esté cancelada o como "No vino", y que el cobro
-- rechace una cita con cortesía) las valida la app con la cita bloqueada FOR UPDATE, en una
-- transacción SERIALIZABLE (src/db/courtesies.ts y src/db/sales.ts).
CREATE TABLE "appointment_courtesies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointment_courtesies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"appointment_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"list_price" bigint NOT NULL,
	"reason" text NOT NULL,
	"business_date" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_courtesies_appointment_key" UNIQUE("location_id","appointment_id"),
	CONSTRAINT "appointment_courtesies_list_price_check" CHECK ("appointment_courtesies"."list_price" >= 0 and "appointment_courtesies"."list_price" % 100 = 0),
	CONSTRAINT "appointment_courtesies_reason_check" CHECK (char_length("appointment_courtesies"."reason") between 3 and 300 and "appointment_courtesies"."reason" = btrim("appointment_courtesies"."reason") and "appointment_courtesies"."reason" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_category_check";--> statement-breakpoint
ALTER TABLE "appointment_courtesies" ADD CONSTRAINT "appointment_courtesies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_courtesies" ADD CONSTRAINT "appointment_courtesies_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_courtesies" ADD CONSTRAINT "appointment_courtesies_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_courtesies_location_date_idx" ON "appointment_courtesies" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','appointment.courtesy','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','client.no_shows_clear','client.consent_withdraw','client.devices_forget','report.export'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('appointment.courtesy','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('client.no_shows_clear','personal'),('client.consent_withdraw','personal'),('client.devices_forget','personal'),('report.export','informes')));
--> statement-breakpoint
SELECT app_apply_grants();
