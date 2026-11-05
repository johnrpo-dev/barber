-- Recibo de una venta por WhatsApp o correo (no es factura electrónica): nueva plantilla en el outbox.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_template_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_check" CHECK ("notifications"."template" in ('otp','booking_confirmed','reminder_24h','reminder_2h','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff','sale_receipt'));--> statement-breakpoint
SELECT app_apply_grants();
