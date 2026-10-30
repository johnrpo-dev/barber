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
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
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
  // Reserva pública (sprint 3). Apagada hasta que el dueño la active.
  publicBookingEnabled: boolean("public_booking_enabled").notNull().default(false),
  publicPhone: text("public_phone"),
  address: text("address"),
  mapsUrl: text("maps_url"),
  /** Citas futuras activas que puede tener un mismo cliente reservando en línea. */
  maxActivePerClient: integer("max_active_per_client").notNull().default(3),
  // Reglas de cobro (sprint 4, docs/sprint-4-cobro-caja.md §1). El servidor las lee al cobrar.
  /** Base de la comisión: precio neto (después del descuento) o bruto. */
  commissionBase: text("commission_base", { enum: ["net", "gross"] }).notNull().default("net"),
  /** Tope del descuento por línea, en puntos básicos (3000 = 30 %). */
  maxDiscountBps: integer("max_discount_bps").notNull().default(3000),
  /** Si recepción puede dar descuentos (además del dueño). */
  receptionCanDiscount: boolean("reception_can_discount").notNull().default(false),
  /** Si la propina pagada con medios electrónicos asume su parte del datáfono. */
  tipsBearCardFees: boolean("tips_bear_card_fees").notNull().default(false),
  /**
   * Diferencia de caja (en centavos, pesos enteros) por encima de la cual un cierre queda marcado
   * para revisión del dueño (migración 0011). Por defecto $20.000.
   */
  cashReviewThreshold: bigint("cash_review_threshold", { mode: "bigint" }).notNull().default(sql`2000000`),
  createdAt: createdAt(),
}, (t) => [
  check("locations_commission_base_check", sql`${t.commissionBase} in ('net','gross')`),
  check("locations_max_discount_bps_check", sql`${t.maxDiscountBps} between 0 and 10000`),
  check(
    "locations_cash_review_threshold_check",
    sql`${t.cashReviewThreshold} >= 0 and ${t.cashReviewThreshold} % 100 = 0 and ${t.cashReviewThreshold} <= 10000000000000`,
  ),
]);

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
    /** SHA-256 del contenido de la petición: la misma clave con otro contenido es un conflicto. */
    requestHash: text("request_hash"),
    reversesEntryId: bigint("reverses_entry_id", { mode: "bigint" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("journal_entries_location_id_id_key").on(t.locationId, t.id),
    check("journal_entries_request_hash_check", sql`${t.requestHash} is null or ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
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
      sql`${t.kind} in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal')`,
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
  /** Plugin twoFactor de better-auth: TOTP activo y verificado. Obligatorio para el dueño. */
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  /** La contraseña la puso otra persona (temporal): debe cambiarla antes de usar el panel. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
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
    /** Última vez que confirmó su identidad (contraseña o código) para una acción crítica. */
    reauthenticatedAt: timestamp("reauthenticated_at", { withTimezone: true }),
    ...authTimestamps(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

/** Plugin twoFactor de better-auth: secreto TOTP y códigos de respaldo, cifrados con BETTER_AUTH_SECRET. */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** false mientras se inscribe: aún no ha escrito un código correcto. */
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [unique("two_factor_user_id_key").on(t.userId)],
);

/**
 * Bloqueo por cuenta tras intentos fallidos (ingreso y reautenticación). Infraestructura, como
 * rate_limit_counters: sin location_id. El sujeto es un HMAC del correo escrito o del usuario.
 */
export const loginThrottles = pgTable(
  "login_throttles",
  {
    subject: text("subject").primaryKey(),
    failures: integer("failures").notNull(),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [
    check("login_throttles_subject_check", sql`${t.subject} ~ '^[0-9a-f]{64}$'`),
    check("login_throttles_failures_check", sql`${t.failures} >= 1`),
  ],
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
    /** Identificador para la reserva pública (el id interno no sale de la app). */
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
    /** Si aparece en la reserva en línea (el dueño puede atender sin ofrecerse al público). */
    bookableOnline: boolean("bookable_online").notNull().default(true),
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
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
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
    /** Primera vez que demostró ser dueño del celular (código correcto). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
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
    /** SHA-256 del contenido de la petición: la misma clave con otro contenido es un conflicto. */
    requestHash: text("request_hash"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointments_location_id_id_key").on(t.locationId, t.id),
    unique("appointments_idempotency_key").on(t.locationId, t.idempotencyKey),
    check("appointments_request_hash_check", sql`${t.requestHash} is null or ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
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

// ─── Reserva pública y notificaciones (sprint 3) ─────────────────────────────
// Ver docs/sprint-3-reserva-publica.md. Los hashes se guardan como hex de 64 caracteres.
// Las garantías (solo-inserción, un código se consume una vez) están en public_booking_guards.

const hexCheck = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;

/** Un código enviado para confirmar una retención. Un reenvío crea una fila nueva y reemplaza la anterior. */
export const bookingVerifications = pgTable(
  "booking_verifications",
  {
    id: id(),
    locationId: locationId(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }).notNull(),
    clientId: bigint("client_id", { mode: "bigint" }).notNull(),
    channel: text("channel", { enum: ["whatsapp", "email"] }).notNull(),
    codeHash: text("code_hash").notNull(),
    /** Hash de la cookie del navegador que pidió el código: el código solo sirve en ese navegador. */
    browserHash: text("browser_hash").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** Evidencia de la autorización (Ley 1581): lo que marcó, desde dónde y con qué navegador. */
    consentChoices: jsonb("consent_choices").$type<{ dataProcessing: boolean; reminders: boolean; marketing: boolean }>().notNull(),
    consentTextVersion: text("consent_text_version").notNull(),
    consentIp: text("consent_ip"),
    consentUserAgent: text("consent_user_agent"),
    /**
     * Lo que escribió quien reserva. Solo pasa al cliente al verificar (y sin reemplazar lo que
     * ya tenga): un extraño que ponga un celular ajeno no cambia el nombre ni el correo de nadie.
     */
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "booking_verifications_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    foreignKey({
      name: "booking_verifications_client_fk",
      columns: [t.locationId, t.clientId],
      foreignColumns: [clients.locationId, clients.id],
    }),
    check("booking_verifications_channel_check", sql`${t.channel} in ('whatsapp','email')`),
    check("booking_verifications_code_hash_check", hexCheck(t.codeHash)),
    check("booking_verifications_browser_hash_check", hexCheck(t.browserHash)),
    check(
      "booking_verifications_attempts_check",
      sql`${t.attempts} between 0 and ${t.maxAttempts} and ${t.maxAttempts} between 1 and 10`,
    ),
    check("booking_verifications_ua_check", sql`${t.consentUserAgent} is null or length(${t.consentUserAgent}) <= 300`),
    check("booking_verifications_ip_check", sql`${t.consentIp} is null or length(${t.consentIp}) <= 45`),
    check("booking_verifications_contact_name_check", sql`${t.contactName} is null or length(${t.contactName}) between 2 and 80`),
    check(
      "booking_verifications_contact_email_check",
      sql`${t.contactEmail} is null or (${t.contactEmail} = lower(${t.contactEmail}) and length(${t.contactEmail}) <= 254)`,
    ),
    uniqueIndex("booking_verifications_one_live")
      .on(t.appointmentId)
      .where(sql`${t.consumedAt} is null and ${t.supersededAt} is null`),
    uniqueIndex("booking_verifications_one_consumed").on(t.appointmentId).where(sql`${t.consumedAt} is not null`),
  ],
);

/** Enlace de gestión de una cita (/cita/[token]). Solo se guarda el hash del token. */
export const appointmentLinks = pgTable(
  "appointment_links",
  {
    id: id(),
    locationId: locationId(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    generation: smallint("generation").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason", { enum: ["cancelled", "rotated", "staff"] }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "appointment_links_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    check("appointment_links_token_hash_check", hexCheck(t.tokenHash)),
    check(
      "appointment_links_revoked_check",
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null) and (${t.revokedReason} is null or ${t.revokedReason} in ('cancelled','rotated','staff'))`,
    ),
    uniqueIndex("appointment_links_one_active").on(t.appointmentId).where(sql`${t.revokedAt} is null`),
  ],
);

/** Autorizaciones del cliente (Ley 1581). Solo-inserción: la última fila por propósito manda. */
export const clientConsents = pgTable(
  "client_consents",
  {
    id: id(),
    locationId: locationId(),
    clientId: bigint("client_id", { mode: "bigint" }).notNull(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }),
    purpose: text("purpose", { enum: ["data_processing", "reminders", "marketing"] }).notNull(),
    granted: boolean("granted").notNull(),
    textVersion: text("text_version").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    source: text("source", { enum: ["online", "staff"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "client_consents_client_fk",
      columns: [t.locationId, t.clientId],
      foreignColumns: [clients.locationId, clients.id],
    }),
    foreignKey({
      name: "client_consents_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    check("client_consents_purpose_check", sql`${t.purpose} in ('data_processing','reminders','marketing')`),
    check("client_consents_source_check", sql`${t.source} in ('online','staff')`),
    check("client_consents_ua_check", sql`${t.userAgent} is null or length(${t.userAgent}) <= 300`),
    check("client_consents_ip_check", sql`${t.ip} is null or length(${t.ip}) <= 45`),
    index("client_consents_latest_idx").on(t.locationId, t.clientId, t.purpose, t.id),
  ],
);

/**
 * Outbox: la intención de avisar algo. Solo-inserción; lo que pasó con cada envío va en
 * notification_events. El destino (celular o correo) se lee del cliente al entregar, así un
 * cliente anonimizado deja de recibir mensajes aunque quedaran pendientes.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    locationId: locationId(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }),
    clientId: bigint("client_id", { mode: "bigint" }),
    channel: text("channel", { enum: ["whatsapp", "email"] }).notNull(),
    template: text("template", {
      enum: [
        // El código: solo se registra que salió (params { code: "[redacted]" }), para la cuota diaria.
        "otp",
        "booking_confirmed",
        "reminder_24h",
        "reminder_2h",
        "appointment_rescheduled",
        "appointment_cancelled_client",
        "appointment_cancelled_staff",
      ],
    }).notNull(),
    /** HMAC del destino, para contar cuotas sin guardar el número. */
    recipientHash: text("recipient_hash").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sendAfter: timestamp("send_after", { withTimezone: true }).notNull().defaultNow(),
    params: jsonb("params").$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notifications_location_id_id_key").on(t.locationId, t.id),
    unique("notifications_dedupe_key").on(t.locationId, t.dedupeKey),
    foreignKey({
      name: "notifications_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    foreignKey({
      name: "notifications_client_fk",
      columns: [t.locationId, t.clientId],
      foreignColumns: [clients.locationId, clients.id],
    }),
    check("notifications_channel_check", sql`${t.channel} in ('whatsapp','email')`),
    check(
      "notifications_template_check",
      sql`${t.template} in ('otp','booking_confirmed','reminder_24h','reminder_2h','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff')`,
    ),
    check("notifications_recipient_hash_check", hexCheck(t.recipientHash)),
    index("notifications_send_after_idx").on(t.sendAfter),
    index("notifications_recipient_idx").on(t.recipientHash, t.createdAt),
  ],
);

/** Cada intento de entrega y su resultado. Solo-inserción. */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: id(),
    locationId: locationId(),
    notificationId: bigint("notification_id", { mode: "bigint" }).notNull(),
    kind: text("kind", { enum: ["attempt", "sent", "failed", "unknown", "suppressed", "delivered", "read"] }).notNull(),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "notification_events_notification_fk",
      columns: [t.locationId, t.notificationId],
      foreignColumns: [notifications.locationId, notifications.id],
    }),
    check(
      "notification_events_kind_check",
      sql`${t.kind} in ('attempt','sent','failed','unknown','suppressed','delivered','read')`,
    ),
    check("notification_events_error_detail_check", sql`${t.errorDetail} is null or length(${t.errorDetail}) <= 300`),
    index("notification_events_notification_idx").on(t.notificationId, t.id),
    index("notification_events_sent_idx").on(t.locationId, t.createdAt).where(sql`${t.kind} = 'sent'`),
  ],
);

/**
 * Contadores de límites por ventana fija. Infraestructura (como la cola de pg-boss): sin
 * location_id. Las cubetas llevan el HMAC de la IP o del contacto, nunca el dato en claro.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull(),
  },
  (t) => [primaryKey({ name: "rate_limit_counters_pkey", columns: [t.bucket, t.windowStart] })],
);

// ─── Cobro, caja y gastos (sprint 4) ─────────────────────────────────────────
// Ver docs/sprint-4-cobro-caja.md §2. Dinero en bigint (centavos) con CHECK >= 0; FK compuestas
// con location_id. Las garantías (solo-inserción, una venta pagada solo pasa a anulada, una caja
// abierta solo pasa a cerrada, totales de la venta = suma de sus filas = su asiento) están en la
// migración 0010_sales_cash (parte escrita a mano).

const amount = (name: string) => bigint(name, { mode: "bigint" });

/** Medio de pago de la sede. El efectivo existe siempre, no se desactiva y no tiene costo. */
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    kind: text("kind", { enum: ["cash", "card", "transfer", "wallet"] }).notNull(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
    /** Costo del medio (datáfono, pasarela) en puntos básicos: 0 a 9999. */
    feeBps: integer("fee_bps").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payment_methods_location_id_id_key").on(t.locationId, t.id),
    uniqueIndex("payment_methods_location_label_key").on(t.locationId, sql`lower(${t.label})`),
    uniqueIndex("payment_methods_one_cash").on(t.locationId).where(sql`${t.kind} = 'cash'`),
    check("payment_methods_kind_check", sql`${t.kind} in ('cash','card','transfer','wallet')`),
    check("payment_methods_fee_check", sql`${t.feeBps} between 0 and 9999`),
    check("payment_methods_cash_check", sql`${t.kind} <> 'cash' or (${t.feeBps} = 0 and ${t.active})`),
    check("payment_methods_label_check", sql`length(trim(${t.label})) between 1 and 40`),
  ],
);

/** Turno de caja. Una abierta por sede; solo pasa de abierta a cerrada, una vez. */
export const cashSessions = pgTable(
  "cash_sessions",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    openedBy: text("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Base contada al abrir. Después de abrir, el saldo de 1105 en el libro es exactamente esto. */
    openingCounted: amount("opening_counted").notNull(),
    /** Saldo de 1105 en el libro al abrir (antes del ajuste de apertura). */
    openingExpected: amount("opening_expected").notNull(),
    openingNote: text("opening_note"),
    /** Asiento de ajuste de apertura (si lo contado difería del libro). */
    openingEntryId: bigint("opening_entry_id", { mode: "bigint" }),
    openIdempotencyKey: text("open_idempotency_key").notNull(),
    openRequestHash: text("open_request_hash").notNull(),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closingCounted: amount("closing_counted"),
    /** Saldo de 1105 en el libro al cerrar (congelado). */
    expectedCash: amount("expected_cash"),
    /** contado − esperado: positivo es sobrante, negativo es faltante. */
    difference: amount("difference"),
    note: text("note"),
    closingEntryId: bigint("closing_entry_id", { mode: "bigint" }),
    closeIdempotencyKey: text("close_idempotency_key"),
    closeRequestHash: text("close_request_hash"),
    /**
     * La diferencia del cierre superó el umbral de la sede: el dueño debe revisarlo. Lo calcula la
     * base al cerrar (trigger de 0011), nunca la app.
     */
    needsReview: boolean("needs_review").notNull().default(false),
    /**
     * La diferencia de la APERTURA (contado − libro) superó el umbral: también va a revisión. La
     * calcula la base al abrir (trigger de 0011). Una sola revisión cubre apertura y cierre.
     */
    openingNeedsReview: boolean("opening_needs_review").notNull().default(false),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    unique("cash_sessions_location_id_id_key").on(t.locationId, t.id),
    check("cash_sessions_closed_after_open_check", sql`${t.closedAt} is null or ${t.closedAt} >= ${t.openedAt}`),
    check(
      "cash_sessions_review_check",
      sql`(${t.reviewedBy} is null) = (${t.reviewedAt} is null)
        and (${t.reviewedAt} is null or ((${t.needsReview} or ${t.openingNeedsReview}) and ${t.closedAt} is not null))
        and (not ${t.needsReview} or ${t.closedAt} is not null)`,
    ),
    index("cash_sessions_needs_review_idx")
      .on(t.locationId)
      .where(sql`(${t.needsReview} or ${t.openingNeedsReview}) and ${t.reviewedAt} is null`),
    unique("cash_sessions_open_idempotency_key").on(t.locationId, t.openIdempotencyKey),
    unique("cash_sessions_close_idempotency_key").on(t.locationId, t.closeIdempotencyKey),
    uniqueIndex("cash_sessions_one_open").on(t.locationId).where(sql`${t.closedAt} is null`),
    foreignKey({
      name: "cash_sessions_opening_entry_fk",
      columns: [t.locationId, t.openingEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "cash_sessions_closing_entry_fk",
      columns: [t.locationId, t.closingEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    check("cash_sessions_amounts_check", sql`${t.openingCounted} >= 0 and ${t.closingCounted} >= 0`),
    check(
      "cash_sessions_opening_check",
      sql`(${t.openingCounted} = ${t.openingExpected}) = (${t.openingEntryId} is null)
        and (${t.openingCounted} = ${t.openingExpected} or length(trim(${t.openingNote})) > 0)`,
    ),
    check("cash_sessions_open_hash_check", hexCheck(t.openRequestHash)),
    check(
      "cash_sessions_closed_check",
      sql`(${t.closedAt} is null) = (${t.closedBy} is null)
        and (${t.closedAt} is null) = (${t.closingCounted} is null)
        and (${t.closedAt} is null) = (${t.expectedCash} is null)
        and (${t.closedAt} is null) = (${t.difference} is null)
        and (${t.closedAt} is null) = (${t.closeIdempotencyKey} is null)
        and (${t.closedAt} is null) = (${t.closeRequestHash} is null)`,
    ),
    check(
      "cash_sessions_difference_check",
      sql`${t.difference} is null or (${t.difference} = ${t.closingCounted} - ${t.expectedCash}
        and (${t.difference} = 0) = (${t.closingEntryId} is null)
        and (${t.difference} = 0 or length(trim(${t.note})) > 0))`,
    ),
  ],
);

/** Venta. Solo-inserción salvo el paso de pagada a anulada (una vez, con su asiento de reversa). */
export const sales = pgTable(
  "sales",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    publicId: text("public_id").notNull().unique(),
    appointmentId: bigint("appointment_id", { mode: "bigint" }),
    clientId: bigint("client_id", { mode: "bigint" }),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["paid", "voided"] }).notNull().default("paid"),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    voidEntryId: bigint("void_entry_id", { mode: "bigint" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    subtotal: amount("subtotal").notNull(),
    discount: amount("discount").notNull(),
    tips: amount("tips").notNull(),
    totalPaid: amount("total_paid").notNull(),
    createdBy: text("created_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("sales_location_id_id_key").on(t.locationId, t.id),
    unique("sales_idempotency_key").on(t.locationId, t.idempotencyKey),
    unique("sales_journal_entry_key").on(t.journalEntryId),
    unique("sales_void_entry_key").on(t.voidEntryId),
    // Una venta pagada por cita: dos cobros de la misma cita son imposibles.
    uniqueIndex("sales_one_paid_per_appointment").on(t.appointmentId).where(sql`${t.status} = 'paid'`),
    foreignKey({
      name: "sales_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    foreignKey({ name: "sales_client_fk", columns: [t.locationId, t.clientId], foreignColumns: [clients.locationId, clients.id] }),
    foreignKey({
      name: "sales_journal_entry_fk",
      columns: [t.locationId, t.journalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "sales_void_entry_fk",
      columns: [t.locationId, t.voidEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    check("sales_status_check", sql`${t.status} in ('paid','voided')`),
    check(
      "sales_voided_check",
      sql`(${t.status} = 'voided') = (${t.voidEntryId} is not null) and (${t.status} = 'voided') = (${t.voidedAt} is not null)`,
    ),
    check(
      "sales_amounts_check",
      sql`${t.subtotal} >= 0 and ${t.discount} >= 0 and ${t.tips} >= 0 and ${t.totalPaid} > 0 and ${t.discount} <= ${t.subtotal}
        and ${t.totalPaid} = ${t.subtotal} - ${t.discount} + ${t.tips}`,
    ),
    check("sales_request_hash_check", hexCheck(t.requestHash)),
    index("sales_location_date_idx").on(t.locationId, t.businessDate),
  ],
);

/** Líneas de la venta, congeladas: descripción, precio, descuento, comisión. Solo-inserción. */
export const saleLines = pgTable(
  "sale_lines",
  {
    id: id(),
    locationId: locationId(),
    saleId: bigint("sale_id", { mode: "bigint" }).notNull(),
    position: smallint("position").notNull(),
    kind: text("kind", { enum: ["service"] }).notNull().default("service"),
    serviceId: bigint("service_id", { mode: "bigint" }).notNull(),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    description: text("description").notNull(),
    unitPrice: amount("unit_price").notNull(),
    discount: amount("discount").notNull(),
    discountReason: text("discount_reason"),
    net: amount("net").notNull(),
    commissionBps: integer("commission_bps").notNull(),
    commission: amount("commission").notNull(),
  },
  (t) => [
    unique("sale_lines_position_key").on(t.saleId, t.position),
    foreignKey({ name: "sale_lines_sale_fk", columns: [t.locationId, t.saleId], foreignColumns: [sales.locationId, sales.id] }),
    foreignKey({ name: "sale_lines_service_fk", columns: [t.locationId, t.serviceId], foreignColumns: [services.locationId, services.id] }),
    foreignKey({
      name: "sale_lines_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("sale_lines_kind_check", sql`${t.kind} in ('service')`),
    check(
      "sale_lines_amounts_check",
      sql`${t.unitPrice} >= 0 and ${t.discount} >= 0 and ${t.discount} <= ${t.unitPrice} and ${t.net} = ${t.unitPrice} - ${t.discount}
        and ${t.commission} >= 0 and ${t.commissionBps} between 0 and 10000`,
    ),
    // La comisión nunca supera el precio de la línea (0011).
    check("sale_lines_commission_check", sql`${t.commission} <= ${t.unitPrice}`),
    check("sale_lines_discount_reason_check", sql`${t.discount} = 0 or length(trim(${t.discountReason})) > 0`),
    index("sale_lines_staff_idx").on(t.locationId, t.staffId),
  ],
);

/** Pagos de la venta (medio, monto aplicado, entregado y cambio, costo congelado). Solo-inserción. */
export const salePayments = pgTable(
  "sale_payments",
  {
    id: id(),
    locationId: locationId(),
    saleId: bigint("sale_id", { mode: "bigint" }).notNull(),
    methodId: bigint("method_id", { mode: "bigint" }).notNull(),
    /** Copia del medio al cobrar: editar el medio después no cambia la venta. */
    kind: text("kind", { enum: ["cash", "card", "transfer", "wallet"] }).notNull(),
    label: text("label").notNull(),
    feeBps: integer("fee_bps").notNull(),
    amount: amount("amount").notNull(),
    tendered: amount("tendered"),
    change: amount("change"),
    fee: amount("fee").notNull(),
  },
  (t) => [
    unique("sale_payments_method_key").on(t.saleId, t.methodId),
    foreignKey({ name: "sale_payments_sale_fk", columns: [t.locationId, t.saleId], foreignColumns: [sales.locationId, sales.id] }),
    foreignKey({
      name: "sale_payments_method_fk",
      columns: [t.locationId, t.methodId],
      foreignColumns: [paymentMethods.locationId, paymentMethods.id],
    }),
    check("sale_payments_kind_check", sql`${t.kind} in ('cash','card','transfer','wallet')`),
    check(
      "sale_payments_amounts_check",
      sql`${t.amount} > 0 and ${t.fee} >= 0 and ${t.fee} < ${t.amount} and ${t.feeBps} between 0 and 9999`,
    ),
    check(
      "sale_payments_cash_check",
      sql`case when ${t.kind} = 'cash'
        then ${t.tendered} is not null and ${t.change} is not null and ${t.change} >= 0 and ${t.tendered} - ${t.change} = ${t.amount} and ${t.fee} = 0
        else ${t.tendered} is null and ${t.change} is null end`,
    ),
  ],
);

/** Propinas por persona: payable = amount − fee_share, y la suma de payable es el crédito a 2380. */
export const saleTips = pgTable(
  "sale_tips",
  {
    id: id(),
    locationId: locationId(),
    saleId: bigint("sale_id", { mode: "bigint" }).notNull(),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    amount: amount("amount").notNull(),
    feeShare: amount("fee_share").notNull(),
    payable: amount("payable").notNull(),
  },
  (t) => [
    unique("sale_tips_staff_key").on(t.saleId, t.staffId),
    foreignKey({ name: "sale_tips_sale_fk", columns: [t.locationId, t.saleId], foreignColumns: [sales.locationId, sales.id] }),
    foreignKey({
      name: "sale_tips_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check(
      "sale_tips_amounts_check",
      sql`${t.amount} > 0 and ${t.feeShare} >= 0 and ${t.payable} > 0 and ${t.payable} = ${t.amount} - ${t.feeShare}`,
    ),
    index("sale_tips_staff_idx").on(t.locationId, t.staffId),
  ],
);

/**
 * Movimientos de efectivo de un turno: cada asiento que toca 1105 mientras la caja está abierta
 * (venta en efectivo, gasto de caja, pago de propinas, consignación, anulación). Sirve para
 * desglosar el turno; el esperado sale siempre del saldo de 1105 en el libro. Solo-inserción.
 */
export const cashMovements = pgTable(
  "cash_movements",
  {
    id: id(),
    locationId: locationId(),
    cashSessionId: bigint("cash_session_id", { mode: "bigint" }).notNull(),
    kind: text("kind", { enum: ["sale", "expense", "tip_payout", "cash_deposit", "reversal"] }).notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    /** Solo pago de propinas: a quién. */
    staffId: bigint("staff_id", { mode: "bigint" }),
    description: text("description").notNull(),
    createdBy: text("created_by").notNull(),
    /** Solo las operaciones que nacen aquí (propinas y consignaciones) llevan su propia clave. */
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("cash_movements_entry_key").on(t.journalEntryId),
    unique("cash_movements_idempotency_key").on(t.locationId, t.idempotencyKey),
    foreignKey({
      name: "cash_movements_session_fk",
      columns: [t.locationId, t.cashSessionId],
      foreignColumns: [cashSessions.locationId, cashSessions.id],
    }),
    foreignKey({
      name: "cash_movements_entry_fk",
      columns: [t.locationId, t.journalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "cash_movements_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("cash_movements_kind_check", sql`${t.kind} in ('sale','expense','tip_payout','cash_deposit','reversal')`),
    check("cash_movements_staff_check", sql`(${t.kind} = 'tip_payout') = (${t.staffId} is not null)`),
    check(
      "cash_movements_hash_check",
      sql`(${t.idempotencyKey} is null) = (${t.requestHash} is null) and (${t.requestHash} is null or ${t.requestHash} ~ '^[0-9a-f]{64}$')`,
    ),
    index("cash_movements_session_idx").on(t.cashSessionId),
    index("cash_movements_staff_idx").on(t.locationId, t.staffId),
  ],
);

/** Categoría de gasto: a qué cuenta de gasto se carga (el contador define el mapeo). */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    name: text("name").notNull(),
    /** Solo cuentas de gasto sin flujo propio (isExpenseCategoryAccount): hoy, 5195. */
    accountCode: text("account_code").notNull().default("5195"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("expense_categories_location_id_id_key").on(t.locationId, t.id),
    uniqueIndex("expense_categories_location_name_key").on(t.locationId, sql`lower(${t.name})`),
    foreignKey({
      name: "expense_categories_account_fk",
      columns: [t.locationId, t.accountCode],
      foreignColumns: [accounts.locationId, accounts.code],
    }),
    // Debe coincidir con isExpenseCategoryAccount() (src/domain/sales/cash.ts); un test lo vigila.
    check("expense_categories_account_check", sql`${t.accountCode} in ('5195')`),
    check("expense_categories_name_check", sql`length(trim(${t.name})) between 1 and 60`),
  ],
);

/** Gasto pagado desde la caja (con su turno) o desde el banco. Solo-inserción. */
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    locationId: locationId(),
    categoryId: bigint("category_id", { mode: "bigint" }).notNull(),
    amount: amount("amount").notNull(),
    paidFrom: text("paid_from", { enum: ["cash", "bank"] }).notNull(),
    cashSessionId: bigint("cash_session_id", { mode: "bigint" }),
    description: text("description").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    createdBy: text("created_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("expenses_idempotency_key").on(t.locationId, t.idempotencyKey),
    unique("expenses_journal_entry_key").on(t.journalEntryId),
    foreignKey({
      name: "expenses_category_fk",
      columns: [t.locationId, t.categoryId],
      foreignColumns: [expenseCategories.locationId, expenseCategories.id],
    }),
    foreignKey({
      name: "expenses_session_fk",
      columns: [t.locationId, t.cashSessionId],
      foreignColumns: [cashSessions.locationId, cashSessions.id],
    }),
    foreignKey({
      name: "expenses_journal_entry_fk",
      columns: [t.locationId, t.journalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    check("expenses_amount_check", sql`${t.amount} > 0`),
    check(
      "expenses_paid_from_check",
      sql`${t.paidFrom} in ('cash','bank') and (${t.paidFrom} = 'cash') = (${t.cashSessionId} is not null)`,
    ),
    check("expenses_description_check", sql`length(trim(${t.description})) between 1 and 200`),
    check("expenses_request_hash_check", hexCheck(t.requestHash)),
    index("expenses_location_date_idx").on(t.locationId, t.businessDate),
  ],
);

/** Solicitud de anulación: recepción la pide, el dueño la decide una sola vez. */
export const voidRequests = pgTable(
  "void_requests",
  {
    id: id(),
    locationId: locationId(),
    saleId: bigint("sale_id", { mode: "bigint" }).notNull(),
    requestedBy: text("requested_by").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    decisionIdempotencyKey: text("decision_idempotency_key"),
    decisionRequestHash: text("decision_request_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("void_requests_idempotency_key").on(t.locationId, t.idempotencyKey),
    unique("void_requests_decision_idempotency_key").on(t.locationId, t.decisionIdempotencyKey),
    uniqueIndex("void_requests_one_pending").on(t.saleId).where(sql`${t.status} = 'pending'`),
    uniqueIndex("void_requests_one_approved").on(t.saleId).where(sql`${t.status} = 'approved'`),
    foreignKey({ name: "void_requests_sale_fk", columns: [t.locationId, t.saleId], foreignColumns: [sales.locationId, sales.id] }),
    check("void_requests_status_check", sql`${t.status} in ('pending','approved','rejected')`),
    check("void_requests_reason_check", sql`length(trim(${t.reason})) between 1 and 300`),
    check(
      "void_requests_decided_check",
      sql`(${t.status} = 'pending') = (${t.decidedBy} is null) and (${t.status} = 'pending') = (${t.decidedAt} is null)
        and (${t.status} = 'pending') = (${t.decisionIdempotencyKey} is null) and (${t.status} = 'pending') = (${t.decisionRequestHash} is null)
        and (${t.status} <> 'rejected' or length(trim(${t.decisionNote})) > 0)`,
    ),
    check("void_requests_request_hash_check", hexCheck(t.requestHash)),
    index("void_requests_location_status_idx").on(t.locationId, t.status, t.id),
  ],
);
