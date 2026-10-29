CREATE TABLE "appointment_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointment_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"appointment_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"generation" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "appointment_links_token_hash_check" CHECK ("appointment_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "appointment_links_revoked_check" CHECK (("appointment_links"."revoked_at" is null) = ("appointment_links"."revoked_reason" is null) and ("appointment_links"."revoked_reason" is null or "appointment_links"."revoked_reason" in ('cancelled','rotated','staff')))
);
--> statement-breakpoint
CREATE TABLE "booking_verifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booking_verifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"appointment_id" bigint NOT NULL,
	"client_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"consent_choices" jsonb NOT NULL,
	"consent_text_version" text NOT NULL,
	"consent_ip" text,
	"consent_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_verifications_channel_check" CHECK ("booking_verifications"."channel" in ('whatsapp','email')),
	CONSTRAINT "booking_verifications_code_hash_check" CHECK ("booking_verifications"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "booking_verifications_browser_hash_check" CHECK ("booking_verifications"."browser_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "booking_verifications_attempts_check" CHECK ("booking_verifications"."attempts" between 0 and "booking_verifications"."max_attempts" and "booking_verifications"."max_attempts" between 1 and 10),
	CONSTRAINT "booking_verifications_ua_check" CHECK ("booking_verifications"."consent_user_agent" is null or length("booking_verifications"."consent_user_agent") <= 300),
	CONSTRAINT "booking_verifications_ip_check" CHECK ("booking_verifications"."consent_ip" is null or length("booking_verifications"."consent_ip") <= 45)
);
--> statement-breakpoint
CREATE TABLE "client_consents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "client_consents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"client_id" bigint NOT NULL,
	"appointment_id" bigint,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"text_version" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_consents_purpose_check" CHECK ("client_consents"."purpose" in ('data_processing','reminders','marketing')),
	CONSTRAINT "client_consents_source_check" CHECK ("client_consents"."source" in ('online','staff')),
	CONSTRAINT "client_consents_ua_check" CHECK ("client_consents"."user_agent" is null or length("client_consents"."user_agent") <= 300),
	CONSTRAINT "client_consents_ip_check" CHECK ("client_consents"."ip" is null or length("client_consents"."ip") <= 45)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"notification_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_kind_check" CHECK ("notification_events"."kind" in ('attempt','sent','failed','unknown','suppressed','delivered','read')),
	CONSTRAINT "notification_events_error_detail_check" CHECK ("notification_events"."error_detail" is null or length("notification_events"."error_detail") <= 300)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"appointment_id" bigint,
	"client_id" bigint,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "notifications_dedupe_key" UNIQUE("location_id","dedupe_key"),
	CONSTRAINT "notifications_channel_check" CHECK ("notifications"."channel" in ('whatsapp','email')),
	CONSTRAINT "notifications_template_check" CHECK ("notifications"."template" in ('booking_confirmed','reminder_24h','reminder_2h','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff')),
	CONSTRAINT "notifications_recipient_hash_check" CHECK ("notifications"."recipient_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "public_booking_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "public_phone" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "maps_url" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "max_active_per_client" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "bookable_online" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_links" ADD CONSTRAINT "appointment_links_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_notification_fk" FOREIGN KEY ("location_id","notification_id") REFERENCES "public"."notifications"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appointment_fk" FOREIGN KEY ("location_id","appointment_id") REFERENCES "public"."appointments"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_client_fk" FOREIGN KEY ("location_id","client_id") REFERENCES "public"."clients"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_links_one_active" ON "appointment_links" USING btree ("appointment_id") WHERE "appointment_links"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_verifications_one_live" ON "booking_verifications" USING btree ("appointment_id") WHERE "booking_verifications"."consumed_at" is null and "booking_verifications"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_verifications_one_consumed" ON "booking_verifications" USING btree ("appointment_id") WHERE "booking_verifications"."consumed_at" is not null;--> statement-breakpoint
CREATE INDEX "client_consents_latest_idx" ON "client_consents" USING btree ("location_id","client_id","purpose","id");--> statement-breakpoint
CREATE INDEX "notification_events_notification_idx" ON "notification_events" USING btree ("notification_id","id");--> statement-breakpoint
CREATE INDEX "notification_events_sent_idx" ON "notification_events" USING btree ("location_id","created_at") WHERE "notification_events"."kind" = 'sent';--> statement-breakpoint
CREATE INDEX "notifications_send_after_idx" ON "notifications" USING btree ("send_after");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_hash","created_at");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_public_id_unique" UNIQUE("public_id");