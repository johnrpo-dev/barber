ALTER TABLE "clients" ADD COLUMN "no_shows_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "walk_in_guard_min" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "no_show_limit" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_walk_in_guard_check" CHECK ("locations"."walk_in_guard_min" between 0 and 240);--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_no_show_limit_check" CHECK ("locations"."no_show_limit" between 1 and 10);