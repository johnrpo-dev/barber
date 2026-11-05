-- Datos del recibo impreso (no es factura electrónica): NIT o cédula y mensaje del pie. Opcionales.
ALTER TABLE "locations" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "receipt_footer" text;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tax_id_check" CHECK ("locations"."tax_id" is null or (length("locations"."tax_id") between 1 and 30));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_receipt_footer_check" CHECK ("locations"."receipt_footer" is null or (length("locations"."receipt_footer") between 1 and 200));--> statement-breakpoint
SELECT app_apply_grants();
