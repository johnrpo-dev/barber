-- Sprint 7: "Salí / Llegué". Quién está físicamente en la barbería, para la fila del walk-in (decisión
-- del dueño: quien sale queda fuera hasta que llega y, al volver, entra de último). Solo-inserción:
-- app_apply_grants le da a la app SELECT e INSERT, sin UPDATE ni DELETE.
CREATE TABLE "staff_presence_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_presence_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "staff_presence_events_kind_check" CHECK ("staff_presence_events"."kind" in ('out','in'))
);
--> statement-breakpoint
ALTER TABLE "staff_presence_events" ADD CONSTRAINT "staff_presence_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_presence_events" ADD CONSTRAINT "staff_presence_events_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_presence_events_staff_at_idx" ON "staff_presence_events" USING btree ("location_id","staff_id","at");
--> statement-breakpoint
SELECT app_apply_grants();
