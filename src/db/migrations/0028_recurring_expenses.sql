-- Sprint 8, parte B: gastos fijos con recordatorio (docs/sprint-8-gastos-controles.md §5).
-- NADA se asienta solo: el sistema muestra los periodos vencidos o por vencer y alguien confirma que
-- se pagó (el formulario de gasto normal, prellenado) o lo omite con un motivo.
-- 1. recurring_expenses: la plantilla (nombre, categoría de la misma sede por FK compuesta, monto
--    estimado en centavos de pesos enteros, pay_mode cash|bank, día 1-28, cada 1-12 meses, mes de
--    inicio y si está activa). La app la crea y la edita: app_apply_grants le da UPDATE SOLO de las
--    columnas de la plantilla (nunca location_id, id, created_by ni created_at). Sin DELETE: se pausa.
-- 2. recurring_expense_runs: solo-inserción. Una fila por periodo (UNIQUE location_id, recurring_id,
--    period): registered lleva el expense_id (FK compuesta a expenses, por eso expenses gana
--    UNIQUE (location_id, id)) y skipped el motivo (3-300, una línea); un CHECK exige uno u otro.
--    Para la app: SELECT e INSERT (el default de app_apply_grants). Además, triggers que prohíben
--    UPDATE, DELETE y TRUNCATE a cualquiera (como el libro): lo que se registró no se "desregistra".
-- 3. Bitácora: recurring_expense.save (configuracion), recurring_expense.register y
--    recurring_expense.skip (finanzas).
-- El gasto de un periodo es un gasto normal (expenses + su asiento de siempre, sin tipos nuevos) en la
-- MISMA transacción SERIALIZABLE que su fila de recurring_expense_runs y el evento, con la clave de
-- idempotencia recurring:<id>:<periodo> (src/db/recurring-expenses.ts).
-- app_apply_grants parte de la última definición (0027) y solo agrega la línea de recurring_expenses.
CREATE TABLE "recurring_expense_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recurring_expense_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"recurring_id" bigint NOT NULL,
	"period" date NOT NULL,
	"outcome" text NOT NULL,
	"expense_id" bigint,
	"skip_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_expense_runs_period_key" UNIQUE("location_id","recurring_id","period"),
	CONSTRAINT "recurring_expense_runs_expense_key" UNIQUE("location_id","expense_id"),
	CONSTRAINT "recurring_expense_runs_period_check" CHECK (extract(day from "recurring_expense_runs"."period") = 1),
	CONSTRAINT "recurring_expense_runs_outcome_check" CHECK (("recurring_expense_runs"."outcome" = 'registered' and "recurring_expense_runs"."expense_id" is not null and "recurring_expense_runs"."skip_reason" is null)
        or ("recurring_expense_runs"."outcome" = 'skipped' and "recurring_expense_runs"."expense_id" is null and "recurring_expense_runs"."skip_reason" is not null
            and char_length("recurring_expense_runs"."skip_reason") between 3 and 300 and "recurring_expense_runs"."skip_reason" = btrim("recurring_expense_runs"."skip_reason") and "recurring_expense_runs"."skip_reason" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
CREATE TABLE "recurring_expenses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recurring_expenses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"name" text NOT NULL,
	"category_id" bigint NOT NULL,
	"estimated_amount" bigint NOT NULL,
	"pay_mode" text NOT NULL,
	"day_of_month" smallint NOT NULL,
	"interval_months" smallint NOT NULL,
	"start_month" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_expenses_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "recurring_expenses_name_check" CHECK (char_length("recurring_expenses"."name") between 3 and 60 and "recurring_expenses"."name" = btrim("recurring_expenses"."name") and "recurring_expenses"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "recurring_expenses_amount_check" CHECK ("recurring_expenses"."estimated_amount" > 0 and "recurring_expenses"."estimated_amount" % 100 = 0 and "recurring_expenses"."estimated_amount" <= 10000000000000),
	CONSTRAINT "recurring_expenses_pay_mode_check" CHECK ("recurring_expenses"."pay_mode" in ('cash','bank')),
	CONSTRAINT "recurring_expenses_day_check" CHECK ("recurring_expenses"."day_of_month" between 1 and 28),
	CONSTRAINT "recurring_expenses_interval_check" CHECK ("recurring_expenses"."interval_months" between 1 and 12),
	CONSTRAINT "recurring_expenses_start_month_check" CHECK (extract(day from "recurring_expenses"."start_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_category_check";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_location_id_id_key" UNIQUE("location_id","id");--> statement-breakpoint
ALTER TABLE "recurring_expense_runs" ADD CONSTRAINT "recurring_expense_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense_runs" ADD CONSTRAINT "recurring_expense_runs_recurring_fk" FOREIGN KEY ("location_id","recurring_id") REFERENCES "public"."recurring_expenses"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expense_runs" ADD CONSTRAINT "recurring_expense_runs_expense_fk" FOREIGN KEY ("location_id","expense_id") REFERENCES "public"."expenses"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_fk" FOREIGN KEY ("location_id","category_id") REFERENCES "public"."expense_categories"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_expenses_location_idx" ON "recurring_expenses" USING btree ("location_id","active");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('sale.checkout','void.request','void.approve','void.reject','cash.open','cash.close','cash.review','expense.add','tips.pay','cash.deposit','day.close','day.reopen','settlement.create','settlement.reverse','advance.create','advance.reverse','appointment.courtesy','recurring_expense.register','recurring_expense.skip','service.create','service.update','service.active','settings.booking','settings.checkout_rules','payment_method.save','expense_category.save','staff.bookable','recurring_expense.save','staff.create','staff.update','staff.password_reset','staff.sessions_revoke','schedule.save','account.password_change','account.two_factor_disable','account.backup_codes','client.erase','client.no_shows_clear','client.consent_withdraw','client.devices_forget','report.export'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_category_check" CHECK (("audit_events"."action", "audit_events"."category") in (('sale.checkout','finanzas'),('void.request','finanzas'),('void.approve','finanzas'),('void.reject','finanzas'),('cash.open','finanzas'),('cash.close','finanzas'),('cash.review','finanzas'),('expense.add','finanzas'),('tips.pay','finanzas'),('cash.deposit','finanzas'),('day.close','finanzas'),('day.reopen','finanzas'),('settlement.create','finanzas'),('settlement.reverse','finanzas'),('advance.create','finanzas'),('advance.reverse','finanzas'),('appointment.courtesy','finanzas'),('recurring_expense.register','finanzas'),('recurring_expense.skip','finanzas'),('service.create','configuracion'),('service.update','configuracion'),('service.active','configuracion'),('settings.booking','configuracion'),('settings.checkout_rules','configuracion'),('payment_method.save','configuracion'),('expense_category.save','configuracion'),('staff.bookable','configuracion'),('recurring_expense.save','configuracion'),('staff.create','personal'),('staff.update','personal'),('staff.password_reset','personal'),('staff.sessions_revoke','personal'),('schedule.save','personal'),('account.password_change','personal'),('account.two_factor_disable','personal'),('account.backup_codes','personal'),('client.erase','personal'),('client.no_shows_clear','personal'),('client.consent_withdraw','personal'),('client.devices_forget','personal'),('report.export','informes')));
--> statement-breakpoint
CREATE TRIGGER recurring_expense_runs_no_mutation BEFORE UPDATE OR DELETE ON recurring_expense_runs
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER recurring_expense_runs_no_truncate BEFORE TRUNCATE ON recurring_expense_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
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
  -- cash_movements, expenses, personal_data_reads, audit_events, recurring_expense_runs.
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
