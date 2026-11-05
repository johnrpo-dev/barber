-- Sprint 6: un solo recordatorio, el mismo día de la cita (unas 3 h antes). Los de 24 h y 2 h siguen
-- permitidos por las filas viejas del outbox, pero ya no se generan.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_template_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_check" CHECK ("notifications"."template" in ('otp','booking_confirmed','reminder_24h','reminder_2h','reminder_same_day','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff','sale_receipt'));--> statement-breakpoint
SELECT app_apply_grants();
