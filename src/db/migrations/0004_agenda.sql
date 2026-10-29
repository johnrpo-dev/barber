CREATE TABLE "appointment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"appointment_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"prev_staff_id" bigint,
	"prev_during" "tstzrange",
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_events_kind_check" CHECK ("appointment_events"."kind" in ('created','status','rescheduled')),
	CONSTRAINT "appointment_events_actor_check" CHECK ("appointment_events"."actor_kind" in ('staff','client','system')),
	CONSTRAINT "appointment_events_staff_actor" CHECK ("appointment_events"."actor_kind" <> 'staff' or "appointment_events"."actor_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"public_id" text NOT NULL,
	"staff_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"client_id" bigint,
	"service_name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"buffer_min" integer NOT NULL,
	"price" bigint NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"during" "tstzrange" NOT NULL,
	"expires_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_note" text,
	"cancelled_late" boolean DEFAULT false NOT NULL,
	"notes" text,
	"idempotency_key" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "appointments_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "appointments_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" in ('pending','confirmed','arrived','in_chair','completed','cancelled','no_show')),
	CONSTRAINT "appointments_source_check" CHECK ("appointments"."source" in ('staff','walk_in','online')),
	CONSTRAINT "appointments_cancel_reason_check" CHECK ("appointments"."cancel_reason" is null or "appointments"."cancel_reason" in ('client','staff','expired','left','duplicate')),
	CONSTRAINT "appointments_cancelled_has_reason" CHECK (("appointments"."status" = 'cancelled') = ("appointments"."cancel_reason" is not null)),
	CONSTRAINT "appointments_pending_expires" CHECK ("appointments"."status" <> 'pending' or "appointments"."expires_at" is not null),
	CONSTRAINT "appointments_client_required" CHECK ("appointments"."client_id" is not null or "appointments"."source" = 'walk_in'),
	CONSTRAINT "appointments_duration_check" CHECK ("appointments"."duration_min" > 0 and "appointments"."buffer_min" >= 0),
	CONSTRAINT "appointments_price_check" CHECK ("appointments"."price" >= 0),
	CONSTRAINT "appointments_during_check" CHECK (not isempty("appointments"."during") and lower_inc("appointments"."during") and not upper_inc("appointments"."during") and not lower_inf("appointments"."during") and not upper_inf("appointments"."during"))
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text,
	"email" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "clients_phone_check" CHECK ("clients"."phone_e164" is null or "clients"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "clients_email_check" CHECK ("clients"."email" is null or "clients"."email" = lower("clients"."email"))
);
--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "time_off_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"staff_id" bigint,
	"during" "tstzrange" NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_kind_check" CHECK ("time_off"."kind" in ('absence','block')),
	CONSTRAINT "time_off_during_check" CHECK (not isempty("time_off"."during") and lower_inc("time_off"."during") and not upper_inc("time_off"."during") and not lower_inf("time_off"."during") and not upper_inf("time_off"."during"))
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "slot_step_min" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "min_advance_min" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "max_advance_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "hold_min" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "free_cancel_hours" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "no_show_grace_min" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_fk" FOREIGN KEY ("location_id","service_id") REFERENCES "public"."services"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_staff_fk" FOREIGN KEY ("location_id","staff_id") REFERENCES "public"."staff_members"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_idx" ON "appointment_events" USING btree ("appointment_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_location_phone_key" ON "clients" USING btree ("location_id","phone_e164") WHERE "clients"."phone_e164" is not null;--> statement-breakpoint
CREATE INDEX "clients_location_name_idx" ON "clients" USING btree ("location_id",lower("name"));