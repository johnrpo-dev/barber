import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tstzrange } from "./tstzrange";

// Convenciones (ver docs/arquitectura.md):
// - IDs internos bigint identity; hacia afuera solo ULID o tokens.
// - Dinero en bigint (centavos, mode "bigint"); nunca real/double ni number en JS.
// - Fechas en timestamptz (UTC); la zona de cada sede vive en locations.timezone.
// - Toda tabla operativa lleva location_id; las FK compuestas impiden cruzar datos entre sedes.
// - Las garantías contables (cuadre, inmutabilidad, días cerrados) están en la migración ledger_guards.

const id = () => bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity();
const locationId = () => bigint("location_id", { mode: "bigint" }).notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const locations = pgTable("locations", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Bogota"),
  currency: char("currency", { length: 3 }).notNull().default("COP"),
  // Reglas de la agenda (una fila por sede; el dueño las ajusta).
  slotStepMin: integer("slot_step_min").notNull().default(15),
  minAdvanceMin: integer("min_advance_min").notNull().default(60),
  maxAdvanceDays: integer("max_advance_days").notNull().default(14),
  holdMin: integer("hold_min").notNull().default(10),
  freeCancelHours: integer("free_cancel_hours").notNull().default(3),
  noShowGraceMin: integer("no_show_grace_min").notNull().default(10),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ["asset", "liability", "equity", "income", "expense"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("accounts_location_id_id_key").on(t.locationId, t.id),
    unique("accounts_location_id_code_key").on(t.locationId, t.code),
    check("accounts_type_check", sql`${t.type} in ('asset','liability','equity','income','expense')`),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    memo: text("memo").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    idempotencyKey: text("idempotency_key"),
    reversesEntryId: bigint("reverses_entry_id", { mode: "bigint" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("journal_entries_location_id_id_key").on(t.locationId, t.id),
    unique("journal_entries_idempotency_key").on(t.locationId, t.idempotencyKey),
    // Un asiento se reversa una sola vez.
    unique("journal_entries_reverses_entry_id_key").on(t.reversesEntryId),
    foreignKey({
      name: "journal_entries_reverses_fk",
      columns: [t.locationId, t.reversesEntryId],
      foreignColumns: [t.locationId, t.id],
    }),
    check(
      "journal_entries_kind_check",
      sql`${t.kind} in ('sale','expense','commission_payout','tip_payout','cash_adjustment','owner_contribution','owner_withdrawal','reversal')`,
    ),
    check("journal_entries_reversal_check", sql`(${t.kind} = 'reversal') = (${t.reversesEntryId} is not null)`),
    index("journal_entries_location_date_idx").on(t.locationId, t.businessDate),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    locationId: locationId(),
    entryId: bigint("entry_id", { mode: "bigint" }).notNull(),
    accountId: bigint("account_id", { mode: "bigint" }).notNull(),
    debit: bigint("debit", { mode: "bigint" }).notNull().default(sql`0`),
    credit: bigint("credit", { mode: "bigint" }).notNull().default(sql`0`),
    memo: text("memo"),
  },
  (t) => [
    foreignKey({
      name: "journal_lines_entry_fk",
      columns: [t.locationId, t.entryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "journal_lines_account_fk",
      columns: [t.locationId, t.accountId],
      foreignColumns: [accounts.locationId, accounts.id],
    }),
    // Exactamente uno de los dos lados es positivo; el otro es cero.
    check(
      "journal_lines_one_side_check",
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} > 0) <> (${t.credit} > 0))`,
    ),
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.locationId, t.accountId),
  ],
);

// ─── Autenticación (better-auth) ─────────────────────────────────────────────
// Las claves de propiedad deben coincidir con los campos de better-auth; los IDs son texto
// generados por better-auth. created_by de los asientos guarda este user.id.

const authTimestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...authTimestamps(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...authTimestamps(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...authTimestamps(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...authTimestamps(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ─── Personal y catálogo ─────────────────────────────────────────────────────

/** Persona que trabaja en una sede. user_id es null si no tiene acceso a la app (p. ej. un barbero sin login). */
export const staffMembers = pgTable(
  "staff_members",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    userId: text("user_id").references(() => user.id),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["owner", "reception", "barber"] }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("staff_members_location_id_id_key").on(t.locationId, t.id),
    unique("staff_members_location_user_key").on(t.locationId, t.userId),
    check("staff_members_role_check", sql`${t.role} in ('owner','reception','barber')`),
  ],
);

export const services = pgTable(
  "services",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    name: text("name").notNull(),
    durationMin: integer("duration_min").notNull(),
    bufferMin: integer("buffer_min").notNull().default(0),
    price: bigint("price", { mode: "bigint" }).notNull(),
    commissionBps: integer("commission_bps").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("services_location_id_id_key").on(t.locationId, t.id),
    uniqueIndex("services_location_name_key").on(t.locationId, sql`lower(${t.name})`),
    check("services_duration_check", sql`${t.durationMin} between 5 and 480 and ${t.durationMin} % 5 = 0`),
    check("services_buffer_check", sql`${t.bufferMin} between 0 and 120 and ${t.bufferMin} % 5 = 0`),
    check("services_price_check", sql`${t.price} >= 0 and ${t.price} % 100 = 0`),
    check("services_commission_check", sql`${t.commissionBps} between 0 and 10000`),
  ],
);

/** Bloques del horario semanal (hora local de la sede). El no-solapamiento lo garantiza la migración staff_guards. */
export const staffSchedules = pgTable(
  "staff_schedules",
  {
    id: id(),
    locationId: locationId(),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    weekday: smallint("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
  },
  (t) => [
    foreignKey({
      name: "staff_schedules_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("staff_schedules_weekday_check", sql`${t.weekday} between 1 and 7`),
    check(
      "staff_schedules_range_check",
      sql`${t.startMin} >= 0 and ${t.endMin} <= 1440 and ${t.startMin} < ${t.endMin} and ${t.startMin} % 5 = 0 and ${t.endMin} % 5 = 0`,
    ),
  ],
);

// ─── Agenda ──────────────────────────────────────────────────────────────────
// Garantías en la migración agenda_guards: sin doble reserva (EXCLUDE), transiciones de estado
// válidas, citas terminadas/canceladas congeladas, nada se borra y el historial es solo-inserción.

/** Datos mínimos (Ley 1581). Un walk-in anónimo no crea cliente. */
export const clients = pgTable(
  "clients",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    name: text("name").notNull(),
    phoneE164: text("phone_e164"),
    email: text("email"),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("clients_location_id_id_key").on(t.locationId, t.id),
    uniqueIndex("clients_location_phone_key").on(t.locationId, t.phoneE164).where(sql`${t.phoneE164} is not null`),
    index("clients_location_name_idx").on(t.locationId, sql`lower(${t.name})`),
    check("clients_phone_check", sql`${t.phoneE164} is null or ${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check("clients_email_check", sql`${t.email} is null or ${t.email} = lower(${t.email})`),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    /** ULID: lo único que sale hacia afuera (enlaces, comprobantes). */
    publicId: text("public_id").notNull().unique(),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    serviceId: bigint("service_id", { mode: "bigint" }).notNull(),
    clientId: bigint("client_id", { mode: "bigint" }),
    // Copia del servicio al agendar: lo cotizado no cambia si después se edita el catálogo.
    // La comisión NO se copia aquí: se congela al cobrar (sprint 4).
    serviceName: text("service_name").notNull(),
    durationMin: integer("duration_min").notNull(),
    bufferMin: integer("buffer_min").notNull(),
    price: bigint("price", { mode: "bigint" }).notNull(),
    status: text("status", {
      enum: ["pending", "confirmed", "arrived", "in_chair", "completed", "cancelled", "no_show"],
    }).notNull(),
    source: text("source", { enum: ["staff", "walk_in", "online"] }).notNull(),
    /** Servicio + limpieza: [inicio, inicio + duración + limpieza). */
    during: tstzrange("during").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    cancelReason: text("cancel_reason", { enum: ["client", "staff", "expired", "left", "duplicate"] }),
    cancelNote: text("cancel_note"),
    cancelledLate: boolean("cancelled_late").notNull().default(false),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointments_location_id_id_key").on(t.locationId, t.id),
    unique("appointments_idempotency_key").on(t.locationId, t.idempotencyKey),
    foreignKey({
      name: "appointments_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    foreignKey({
      name: "appointments_service_fk",
      columns: [t.locationId, t.serviceId],
      foreignColumns: [services.locationId, services.id],
    }),
    foreignKey({
      name: "appointments_client_fk",
      columns: [t.locationId, t.clientId],
      foreignColumns: [clients.locationId, clients.id],
    }),
    check(
      "appointments_status_check",
      sql`${t.status} in ('pending','confirmed','arrived','in_chair','completed','cancelled','no_show')`,
    ),
    check("appointments_source_check", sql`${t.source} in ('staff','walk_in','online')`),
    check(
      "appointments_cancel_reason_check",
      sql`${t.cancelReason} is null or ${t.cancelReason} in ('client','staff','expired','left','duplicate')`,
    ),
    check("appointments_cancelled_has_reason", sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    check("appointments_pending_expires", sql`${t.status} <> 'pending' or ${t.expiresAt} is not null`),
    check("appointments_client_required", sql`${t.clientId} is not null or ${t.source} = 'walk_in'`),
    check("appointments_duration_check", sql`${t.durationMin} > 0 and ${t.bufferMin} >= 0`),
    check("appointments_price_check", sql`${t.price} >= 0`),
    check(
      "appointments_during_check",
      sql`not isempty(${t.during}) and lower_inc(${t.during}) and not upper_inc(${t.during}) and not lower_inf(${t.during}) and not upper_inf(${t.during})`,
    ),
  ],
);

/** Historial de cada cita: quién cambió qué y cuándo. Solo-inserción. */
export const appointmentEvents = pgTable(
  "appointment_events",
  {
    id: id(),
    locationId: locationId(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }).notNull(),
    kind: text("kind", { enum: ["created", "status", "rescheduled"] }).notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    prevStaffId: bigint("prev_staff_id", { mode: "bigint" }),
    prevDuring: tstzrange("prev_during"),
    actorKind: text("actor_kind", { enum: ["staff", "client", "system"] }).notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "appointment_events_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    check("appointment_events_kind_check", sql`${t.kind} in ('created','status','rescheduled')`),
    check("appointment_events_actor_check", sql`${t.actorKind} in ('staff','client','system')`),
    check("appointment_events_staff_actor", sql`${t.actorKind} <> 'staff' or ${t.actorUserId} is not null`),
    index("appointment_events_appointment_idx").on(t.appointmentId, t.id),
  ],
);

/** Ausencias y bloqueos. staff_id null = cierre de toda la sede (p. ej. festivo). */
export const timeOff = pgTable(
  "time_off",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    staffId: bigint("staff_id", { mode: "bigint" }),
    during: tstzrange("during").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    kind: text("kind", { enum: ["absence", "block"] }).notNull(),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "time_off_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("time_off_kind_check", sql`${t.kind} in ('absence','block')`),
    check(
      "time_off_during_check",
      sql`not isempty(${t.during}) and lower_inc(${t.during}) and not upper_inc(${t.during}) and not lower_inf(${t.during}) and not upper_inf(${t.during})`,
    ),
  ],
);

/** Cierre y reapertura de días contables. Solo-inserción: el último evento manda. */
export const dayCloseEvents = pgTable(
  "day_close_events",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    action: text("action", { enum: ["close", "reopen"] }).notNull(),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("day_close_events_action_check", sql`${t.action} in ('close','reopen')`),
    check("day_close_events_reopen_reason_check", sql`${t.action} = 'close' or ${t.reason} is not null`),
    index("day_close_events_location_date_idx").on(t.locationId, t.businessDate, t.id),
  ],
);
