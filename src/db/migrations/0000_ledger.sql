CREATE TABLE "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "accounts_location_id_code_key" UNIQUE("location_id","code"),
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" in ('asset','liability','equity','income','expense'))
);
--> statement-breakpoint
CREATE TABLE "day_close_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "day_close_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_close_events_action_check" CHECK ("day_close_events"."action" in ('close','reopen')),
	CONSTRAINT "day_close_events_reopen_reason_check" CHECK ("day_close_events"."action" = 'close' or "day_close_events"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"memo" text NOT NULL,
	"currency" char(3) NOT NULL,
	"idempotency_key" text,
	"reverses_entry_id" bigint,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_location_id_id_key" UNIQUE("location_id","id"),
	CONSTRAINT "journal_entries_idempotency_key" UNIQUE("location_id","idempotency_key"),
	CONSTRAINT "journal_entries_reverses_entry_id_key" UNIQUE("reverses_entry_id"),
	CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('sale','expense','commission_payout','tip_payout','cash_adjustment','owner_contribution','owner_withdrawal','reversal')),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("journal_entries"."kind" = 'reversal') = ("journal_entries"."reverses_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"location_id" bigint NOT NULL,
	"entry_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	CONSTRAINT "journal_lines_one_side_check" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and (("journal_lines"."debit" > 0) <> ("journal_lines"."credit" > 0)))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Bogota' NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close_events" ADD CONSTRAINT "day_close_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("location_id","reverses_entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("location_id","entry_id") REFERENCES "public"."journal_entries"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("location_id","account_id") REFERENCES "public"."accounts"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "day_close_events_location_date_idx" ON "day_close_events" USING btree ("location_id","business_date","id");--> statement-breakpoint
CREATE INDEX "journal_entries_location_date_idx" ON "journal_entries" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("location_id","account_id");