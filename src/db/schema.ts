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
import { AUDIT_ACTIONS, AUDIT_CATEGORY, AUDIT_CATEGORIES } from "@/domain/audit/events";
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
  /** Walk-in (sprint 7): el barbero con una cita que empieza en menos de estos minutos no recibe walk-ins. */
  walkInGuardMin: integer("walk_in_guard_min").notNull().default(60),
  /** Faltas ("No vino") con las que se suspende la reserva en línea del cliente (sprint 7). */
  noShowLimit: integer("no_show_limit").notNull().default(2),
  // Reserva pública (sprint 3). Apagada hasta que el dueño la active.
  publicBookingEnabled: boolean("public_booking_enabled").notNull().default(false),
  /**
   * Sprint 7 (decisión del dueño): la reserva en línea se confirma sin código por WhatsApp. Encendido,
   * vuelve el flujo con código (si aparecen reservas falsas con números ajenos).
   */
  bookingRequiresCode: boolean("booking_requires_code").notNull().default(false),
  publicPhone: text("public_phone"),
  address: text("address"),
  mapsUrl: text("maps_url"),
  // Encabezado y pie del recibo impreso (no es factura electrónica). Opcionales.
  /** NIT o cédula del negocio, tal como debe aparecer en el recibo. */
  taxId: text("tax_id"),
  /** Mensaje al pie del recibo ("¡Gracias por venir!"). */
  receiptFooter: text("receipt_footer"),
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
  check("locations_walk_in_guard_check", sql`${t.walkInGuardMin} between 0 and 240`),
  check("locations_no_show_limit_check", sql`${t.noShowLimit} between 1 and 10`),
  check("locations_max_discount_bps_check", sql`${t.maxDiscountBps} between 0 and 10000`),
  check("locations_tax_id_check", sql`${t.taxId} is null or (length(${t.taxId}) between 1 and 30)`),
  check("locations_receipt_footer_check", sql`${t.receiptFooter} is null or (length(${t.receiptFooter}) between 1 and 200)`),
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
      sql`${t.kind} in ('sale','expense','commission_payout','tip_payout','cash_deposit','cash_adjustment','owner_contribution','owner_withdrawal','reversal','staff_advance')`,
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

/**
 * Qué servicios hace cada persona. Quien no tiene un servicio no se ofrece para él (agenda, reserva
 * en línea, walk-in). Al crear un servicio o una persona se asigna todo; el dueño lo acota en Personal.
 */
export const staffServices = pgTable(
  "staff_services",
  {
    locationId: locationId(),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    serviceId: bigint("service_id", { mode: "bigint" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "staff_services_pkey", columns: [t.locationId, t.staffId, t.serviceId] }),
    foreignKey({ name: "staff_services_staff_fk", columns: [t.locationId, t.staffId], foreignColumns: [staffMembers.locationId, staffMembers.id] }),
    foreignKey({ name: "staff_services_service_fk", columns: [t.locationId, t.serviceId], foreignColumns: [services.locationId, services.id] }),
    index("staff_services_service_idx").on(t.locationId, t.serviceId),
  ],
);

/**
 * "Salí / Llegué" (sprint 7): quién está físicamente en la barbería, para la fila del walk-in.
 * Solo-inserción (la app no tiene UPDATE ni DELETE): manda la última marca de hoy, y el historial
 * dice quién marcó a quién. No toca la agenda ni la reserva en línea.
 */
export const staffPresenceEvents = pgTable(
  "staff_presence_events",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    kind: text("kind", { enum: ["out", "in"] }).notNull(),
    /** Hora de la base, no del cliente. */
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    foreignKey({ name: "staff_presence_events_staff_fk", columns: [t.locationId, t.staffId], foreignColumns: [staffMembers.locationId, staffMembers.id] }),
    check("staff_presence_events_kind_check", sql`${t.kind} in ('out','in')`),
    index("staff_presence_events_staff_at_idx").on(t.locationId, t.staffId, t.at),
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
    /**
     * Desde cuándo vuelven a contar sus faltas: recepción o el dueño le quitaron la suspensión de
     * la reserva en línea (sprint 7). Las faltas anteriores ya no cuentan.
     */
    noShowsClearedAt: timestamp("no_shows_cleared_at", { withTimezone: true }),
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
    // Informe de inasistencias por rango (sprint 5): citas por su inicio.
    index("appointments_location_start_idx").on(t.locationId, sql`lower(${t.during})`),
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

/**
 * Celular recordado en un navegador: tras verificar el código una vez, el cliente reserva desde ese
 * dispositivo sin pedir otro. La base guarda solo el SHA-256 del token (la cookie lleva el token).
 * Vence, se revoca con "No soy yo" y con la supresión de datos del cliente.
 */
export const clientDevices = pgTable(
  "client_devices",
  {
    id: id(),
    locationId: locationId(),
    clientId: bigint("client_id", { mode: "bigint" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "client_devices_client_fk", columns: [t.locationId, t.clientId], foreignColumns: [clients.locationId, clients.id] }),
    check("client_devices_token_hash_check", hexCheck(t.tokenHash)),
    index("client_devices_client_idx").on(t.locationId, t.clientId),
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
        // El único recordatorio desde el sprint 6 (migración 0018); los dos de arriba ya no se generan.
        "reminder_same_day",
        "appointment_rescheduled",
        "appointment_cancelled_client",
        "appointment_cancelled_staff",
        // Recibo de una venta (migración 0015): sin cita obligatoria; la venta va en dedupe_key.
        "sale_receipt",
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
      sql`${t.template} in ('otp','booking_confirmed','reminder_24h','reminder_2h','reminder_same_day','appointment_rescheduled','appointment_cancelled_client','appointment_cancelled_staff','sale_receipt')`,
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
    // Los saldos por persona (0013) solo miran líneas con comisión.
    index("sale_lines_staff_commission_idx").on(t.locationId, t.staffId).where(sql`${t.commission} > 0`),
    // Para las FK compuestas de las líneas de liquidación (sprint 5).
    unique("sale_lines_location_id_id_key").on(t.locationId, t.id),
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
    kind: text("kind", { enum: ["sale", "expense", "tip_payout", "cash_deposit", "reversal", "commission_payout", "staff_advance"] }).notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    /** Pago de propinas, liquidación o anticipo: a quién. */
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
    check(
      "cash_movements_kind_check",
      sql`${t.kind} in ('sale','expense','tip_payout','cash_deposit','reversal','commission_payout','staff_advance')`,
    ),
    check(
      "cash_movements_staff_check",
      sql`(${t.kind} in ('tip_payout','commission_payout','staff_advance')) = (${t.staffId} is not null)`,
    ),
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
    // Para la FK compuesta de recurring_expense_runs (0028): el gasto de un periodo es de la misma sede.
    unique("expenses_location_id_id_key").on(t.locationId, t.id),
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

// ─── Seguridad y datos personales (sprint 5, migración 0012) ─────────────────

/**
 * Bandeja de avisos de seguridad para el dueño (hoy: se disparó un bloqueo por intentos fallidos).
 * Infraestructura, como login_throttles: sin location_id (las cuentas del personal no son de una
 * sede). Sin datos personales: ni correo escrito, ni IP, ni sujeto; solo el id interno del usuario
 * cuando el bloqueo es de una cuenta que existe. El worker la entrega con alertSender().
 */
export const securityAlerts = pgTable(
  "security_alerts",
  {
    id: id(),
    kind: text("kind", { enum: ["login_lock"] }).notNull(),
    throttleKind: text("throttle_kind", { enum: ["login", "login-ip", "reauth", "password", "totp-login"] }).notNull(),
    /** Cuenta del personal afectada, si existe. El correo escrito nunca se guarda. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    failures: integer("failures").notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
    /** Ventana de 15 minutos: una sola fila pendiente por (tipo, cuenta o "sin cuenta", ventana). */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    /** Cuántos bloqueos resume esta fila. Un ataque suma aquí; no llena la tabla. */
    occurrences: integer("occurrences").notNull().default(1),
    createdAt: createdAt(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    check("security_alerts_kind_check", sql`${t.kind} in ('login_lock')`),
    check("security_alerts_throttle_kind_check", sql`${t.throttleKind} in ('login','login-ip','reauth','password','totp-login')`),
    check("security_alerts_failures_check", sql`${t.failures} >= 1`),
    check("security_alerts_occurrences_check", sql`${t.occurrences} >= 1`),
    index("security_alerts_pending_idx").on(t.id).where(sql`${t.notifiedAt} is null`),
    uniqueIndex("security_alerts_window_key")
      .on(t.throttleKind, sql`coalesce(${t.userId}, '')`, t.windowStart)
      .where(sql`${t.notifiedAt} is null`),
  ],
);

/**
 * Auditoría de lecturas de datos de contacto de clientes (Ley 1581): quién vio el celular completo
 * de qué clientes, dónde y cuándo. Solo-inserción (trigger). Una fila por (persona, pantalla,
 * conjunto de clientes, ventana de 10 minutos): recargar la agenda no la llena.
 */
export const personalDataReads = pgTable(
  "personal_data_reads",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    context: text("context", { enum: ["agenda_day", "client_search"] }).notNull(),
    clientIds: bigint("client_ids", { mode: "bigint" }).array().notNull(),
    /** SHA-256 de la lista ordenada de clientes: deduplica dentro de la ventana. */
    clientsHash: text("clients_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "personal_data_reads_staff_fk", columns: [t.locationId, t.staffId], foreignColumns: [staffMembers.locationId, staffMembers.id] }),
    unique("personal_data_reads_window_key").on(t.locationId, t.staffId, t.context, t.clientsHash, t.windowStart),
    check("personal_data_reads_context_check", sql`${t.context} in ('agenda_day','client_search')`),
    check("personal_data_reads_clients_check", sql`cardinality(${t.clientIds}) between 1 and 500`),
    check("personal_data_reads_hash_check", hexCheck(t.clientsHash)),
    index("personal_data_reads_client_idx").using("gin", t.clientIds),
    index("personal_data_reads_created_idx").on(t.locationId, t.createdAt),
  ],
);

// ─── Comisiones, anticipos y auditoría (sprint 5, migración 0013) ────────────
// docs/sprint-5-comisiones-informes.md §2 y §8. Solo-inserción salvo el paso único a "revertida"
// (y `reversed` en las líneas), que controlan los triggers de la parte escrita a mano de 0013, junto
// con el número consecutivo, las reglas de cada línea, los totales = líneas = asiento y la
// completitud de la liquidación (al hacer COMMIT).

const wholePesos = (column: unknown) => sql`${column} % 100 = 0`;
const reasonCheck = (column: unknown) => sql`length(trim(${column})) between 3 and 300`;

/** Liquidación de comisiones de una persona hasta una fecha de corte. */
export const commissionSettlements = pgTable(
  "commission_settlements",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    publicId: text("public_id").notNull(),
    /** Consecutivo por sede (serie de liquidaciones). Lo pone un trigger; la app manda 0. */
    number: bigint("number", { mode: "bigint" }).notNull().default(sql`0`),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    /** Informativo: la fecha de la comisión más antigua incluida, o el corte si no hay ninguna. */
    periodFrom: date("period_from", { mode: "string" }).notNull(),
    cutoffDate: date("cutoff_date", { mode: "string" }).notNull(),
    /** Día contable del pago. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["settled", "reversed"] }).notNull().default("settled"),
    paidFrom: text("paid_from", { enum: ["cash", "bank"] }),
    cashSessionId: bigint("cash_session_id", { mode: "bigint" }),
    commissionTotal: amount("commission_total").notNull(),
    clawbackTotal: amount("clawback_total").notNull(),
    tipsTotal: amount("tips_total").notNull(),
    adjustmentsTotal: amount("adjustments_total").notNull(),
    advanceDeduction: amount("advance_deduction").notNull(),
    carryOver: amount("carry_over").notNull(),
    payout: amount("payout").notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    reversalEntryId: bigint("reversal_entry_id", { mode: "bigint" }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversalReason: text("reversal_reason"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    reversalRequestHash: text("reversal_request_hash"),
  },
  (t) => [
    unique("commission_settlements_location_id_id_key").on(t.locationId, t.id),
    unique("commission_settlements_public_id_key").on(t.publicId),
    unique("commission_settlements_number_key").on(t.locationId, t.number),
    unique("commission_settlements_idempotency_key").on(t.locationId, t.idempotencyKey),
    unique("commission_settlements_reversal_idempotency_key").on(t.locationId, t.reversalIdempotencyKey),
    unique("commission_settlements_journal_entry_key").on(t.journalEntryId),
    unique("commission_settlements_reversal_entry_key").on(t.reversalEntryId),
    foreignKey({
      name: "commission_settlements_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    foreignKey({
      name: "commission_settlements_session_fk",
      columns: [t.locationId, t.cashSessionId],
      foreignColumns: [cashSessions.locationId, cashSessions.id],
    }),
    foreignKey({
      name: "commission_settlements_entry_fk",
      columns: [t.locationId, t.journalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "commission_settlements_reversal_entry_fk",
      columns: [t.locationId, t.reversalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    check("commission_settlements_number_check", sql`${t.number} > 0`),
    check("commission_settlements_status_check", sql`${t.status} in ('settled','reversed')`),
    check(
      "commission_settlements_payout_check",
      sql`${t.payout} = ${t.commissionTotal} - ${t.clawbackTotal} + ${t.tipsTotal} + ${t.adjustmentsTotal} - ${t.advanceDeduction} + ${t.carryOver}
        and ${t.payout} >= 0 and ${t.commissionTotal} >= 0 and ${t.clawbackTotal} >= 0 and ${t.advanceDeduction} >= 0 and ${t.carryOver} >= 0
        and not (${t.advanceDeduction} > 0 and ${t.carryOver} > 0) and (${t.carryOver} = 0 or ${t.payout} = 0)
        and ${t.payout} <= 10000000000000`,
    ),
    check(
      "commission_settlements_whole_pesos_check",
      sql`${wholePesos(t.commissionTotal)} and ${wholePesos(t.clawbackTotal)} and ${wholePesos(t.tipsTotal)} and ${wholePesos(t.adjustmentsTotal)}
        and ${wholePesos(t.advanceDeduction)} and ${wholePesos(t.carryOver)} and ${wholePesos(t.payout)}`,
    ),
    check(
      "commission_settlements_paid_from_check",
      sql`(${t.paidFrom} is null) = (${t.payout} = 0) and (${t.paidFrom} is null or ${t.paidFrom} in ('cash','bank'))
        and (${t.cashSessionId} is not null) = (${t.paidFrom} is not distinct from 'cash')`,
    ),
    check("commission_settlements_dates_check", sql`${t.periodFrom} <= ${t.cutoffDate} and ${t.cutoffDate} <= ${t.businessDate}`),
    check(
      "commission_settlements_reversed_check",
      sql`(${t.status} = 'reversed') = (${t.reversalEntryId} is not null)
        and (${t.status} = 'reversed') = (${t.reversedAt} is not null)
        and (${t.status} = 'reversed') = (${t.reversedBy} is not null)
        and (${t.status} = 'reversed') = (${t.reversalIdempotencyKey} is not null)
        and (${t.status} = 'reversed') = (${t.reversalRequestHash} is not null)
        and (${t.status} <> 'reversed' or ${reasonCheck(t.reversalReason)})`,
    ),
    check("commission_settlements_note_check", sql`${t.note} is null or length(trim(${t.note})) between 1 and 300`),
    check(
      "commission_settlements_hash_check",
      sql`${hexCheck(t.requestHash)} and (${t.reversalRequestHash} is null or ${hexCheck(t.reversalRequestHash)})`,
    ),
    index("commission_settlements_staff_idx").on(t.locationId, t.staffId, t.number),
    index("commission_settlements_location_date_idx").on(t.locationId, t.businessDate),
  ],
);

/** Detalle de la liquidación. `amount` lleva signo: su efecto sobre el pago (payout = Σ amount). */
export const commissionSettlementLines = pgTable(
  "commission_settlement_lines",
  {
    id: id(),
    locationId: locationId(),
    settlementId: bigint("settlement_id", { mode: "bigint" }).notNull(),
    kind: text("kind", { enum: ["commission", "clawback", "tips", "adjustment", "advance_deduction", "carry_over"] }).notNull(),
    saleLineId: bigint("sale_line_id", { mode: "bigint" }),
    amount: amount("amount").notNull(),
    reason: text("reason"),
    /** Solo pasa de false a true, una vez, cuando su liquidación se revierte (trigger). */
    reversed: boolean("reversed").notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: "commission_settlement_lines_settlement_fk",
      columns: [t.locationId, t.settlementId],
      foreignColumns: [commissionSettlements.locationId, commissionSettlements.id],
    }),
    foreignKey({
      name: "commission_settlement_lines_sale_line_fk",
      columns: [t.locationId, t.saleLineId],
      foreignColumns: [saleLines.locationId, saleLines.id],
    }),
    check(
      "commission_settlement_lines_kind_check",
      sql`${t.kind} in ('commission','clawback','tips','adjustment','advance_deduction','carry_over')`,
    ),
    check(
      "commission_settlement_lines_shape_check",
      sql`(${t.kind} in ('commission','clawback')) = (${t.saleLineId} is not null)
        and (${t.kind} = 'adjustment') = (${t.reason} is not null)
        and (${t.reason} is null or ${reasonCheck(t.reason)})`,
    ),
    check(
      "commission_settlement_lines_amount_check",
      sql`${t.amount} <> 0 and ${wholePesos(t.amount)} and abs(${t.amount}) <= 10000000000000
        and (${t.kind} not in ('commission','carry_over') or ${t.amount} > 0)
        and (${t.kind} not in ('clawback','advance_deduction') or ${t.amount} < 0)`,
    ),
    uniqueIndex("commission_settlement_lines_commission_once")
      .on(t.locationId, t.saleLineId)
      .where(sql`${t.kind} = 'commission' and not ${t.reversed}`),
    uniqueIndex("commission_settlement_lines_clawback_once")
      .on(t.locationId, t.saleLineId)
      .where(sql`${t.kind} = 'clawback' and not ${t.reversed}`),
    uniqueIndex("commission_settlement_lines_single_kind")
      .on(t.settlementId, t.kind)
      .where(sql`${t.kind} in ('tips','advance_deduction','carry_over')`),
    index("commission_settlement_lines_settlement_idx").on(t.settlementId),
    index("commission_settlement_lines_sale_line_idx").on(t.locationId, t.saleLineId),
  ],
);

/** Anticipo a una persona, desde la caja o el banco (1365 contra 1105 o 1110). */
export const staffAdvances = pgTable(
  "staff_advances",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    publicId: text("public_id").notNull(),
    /** Consecutivo por sede (serie de anticipos). Lo pone un trigger; la app manda 0. */
    number: bigint("number", { mode: "bigint" }).notNull().default(sql`0`),
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    amount: amount("amount").notNull(),
    paidFrom: text("paid_from", { enum: ["cash", "bank"] }).notNull(),
    cashSessionId: bigint("cash_session_id", { mode: "bigint" }),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).notNull(),
    status: text("status", { enum: ["active", "reversed"] }).notNull().default("active"),
    reversalEntryId: bigint("reversal_entry_id", { mode: "bigint" }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversalReason: text("reversal_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    reversalRequestHash: text("reversal_request_hash"),
  },
  (t) => [
    unique("staff_advances_public_id_key").on(t.publicId),
    unique("staff_advances_number_key").on(t.locationId, t.number),
    unique("staff_advances_idempotency_key").on(t.locationId, t.idempotencyKey),
    unique("staff_advances_reversal_idempotency_key").on(t.locationId, t.reversalIdempotencyKey),
    unique("staff_advances_journal_entry_key").on(t.journalEntryId),
    unique("staff_advances_reversal_entry_key").on(t.reversalEntryId),
    foreignKey({ name: "staff_advances_staff_fk", columns: [t.locationId, t.staffId], foreignColumns: [staffMembers.locationId, staffMembers.id] }),
    foreignKey({
      name: "staff_advances_session_fk",
      columns: [t.locationId, t.cashSessionId],
      foreignColumns: [cashSessions.locationId, cashSessions.id],
    }),
    foreignKey({
      name: "staff_advances_entry_fk",
      columns: [t.locationId, t.journalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    foreignKey({
      name: "staff_advances_reversal_entry_fk",
      columns: [t.locationId, t.reversalEntryId],
      foreignColumns: [journalEntries.locationId, journalEntries.id],
    }),
    check("staff_advances_number_check", sql`${t.number} > 0`),
    check("staff_advances_amount_check", sql`${t.amount} > 0 and ${wholePesos(t.amount)} and ${t.amount} <= 10000000000000`),
    check(
      "staff_advances_paid_from_check",
      sql`${t.paidFrom} in ('cash','bank') and (${t.paidFrom} = 'cash') = (${t.cashSessionId} is not null)`,
    ),
    check("staff_advances_reason_check", reasonCheck(t.reason)),
    check("staff_advances_status_check", sql`${t.status} in ('active','reversed')`),
    check(
      "staff_advances_reversed_check",
      sql`(${t.status} = 'reversed') = (${t.reversalEntryId} is not null)
        and (${t.status} = 'reversed') = (${t.reversedAt} is not null)
        and (${t.status} = 'reversed') = (${t.reversedBy} is not null)
        and (${t.status} = 'reversed') = (${t.reversalIdempotencyKey} is not null)
        and (${t.status} = 'reversed') = (${t.reversalRequestHash} is not null)
        and (${t.status} <> 'reversed' or ${reasonCheck(t.reversalReason)})`,
    ),
    check(
      "staff_advances_hash_check",
      sql`${hexCheck(t.requestHash)} and (${t.reversalRequestHash} is null or ${hexCheck(t.reversalRequestHash)})`,
    ),
    index("staff_advances_staff_idx").on(t.locationId, t.staffId, t.number),
  ],
);

/**
 * Bitácora de auditoría (§8): acciones financieras, de configuración, de personal y exportaciones.
 * Solo-inserción; la hora la pone la base. Sin datos personales de clientes. Se guarda indefinidamente.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id").notNull(),
    actorStaffId: bigint("actor_staff_id", { mode: "bigint" }),
    action: text("action").notNull(),
    category: text("category", { enum: AUDIT_CATEGORIES }).notNull(),
    targetKind: text("target_kind").notNull(),
    targetRef: text("target_ref"),
    summary: text("summary").notNull(),
    changes: jsonb("changes"),
  },
  (t) => [
    foreignKey({
      name: "audit_events_actor_staff_fk",
      columns: [t.locationId, t.actorStaffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("audit_events_action_check", sql`${t.action} in (${sql.raw(AUDIT_ACTIONS.map((a) => `'${a}'`).join(","))})`),
    check(
      "audit_events_action_category_check",
      sql`(${t.action}, ${t.category}) in (${sql.raw(AUDIT_ACTIONS.map((a) => `('${a}','${AUDIT_CATEGORY[a]}')`).join(","))})`,
    ),
    check("audit_events_category_check", sql`${t.category} in (${sql.raw(AUDIT_CATEGORIES.map((c) => `'${c}'`).join(","))})`),
    check("audit_events_summary_check", sql`length(${t.summary}) between 1 and 300 and strpos(${t.summary}, chr(10)) = 0 and strpos(${t.summary}, chr(13)) = 0`),
    check(
      "audit_events_target_check",
      sql`length(${t.targetKind}) between 1 and 40 and (${t.targetRef} is null or length(${t.targetRef}) between 1 and 80)`,
    ),
    check(
      "audit_events_changes_check",
      sql`${t.changes} is null or (jsonb_typeof(${t.changes}) = 'array' and octet_length(${t.changes}::text) <= 4096)`,
    ),
    index("audit_events_location_id_idx").on(t.locationId, t.id.desc()),
    index("audit_events_location_occurred_idx").on(t.locationId, t.occurredAt),
  ],
);

// ─── Cortesías (sprint 8, migración 0026) ────────────────────────────────────
// docs/sprint-8-gastos-controles.md §4. Una cita atendida que el negocio regala NO es una venta de $0:
// no hay asiento, ni comisión, ni medio de pago. Es este registro aparte, solo-inserción para la app
// (app_apply_grants le da SELECT e INSERT, sin UPDATE ni DELETE). Una cita tiene a lo sumo una
// cortesía; quién la da, que no tenga venta y su estado los valida src/db/courtesies.ts con la cita
// bloqueada FOR UPDATE, y el cobro (src/db/sales.ts) rechaza una cita con cortesía.

/** Cortesía de una cita: el precio de lista congelado (el de la cita) y el motivo. */
export const appointmentCourtesies = pgTable(
  "appointment_courtesies",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    appointmentId: bigint("appointment_id", { mode: "bigint" }).notNull(),
    /** Quien atendió la cita (el profesional de la cita): el informe agrupa por esta persona. */
    staffId: bigint("staff_id", { mode: "bigint" }).notNull(),
    /** Precio de lista congelado, en centavos (pesos enteros): lo que se habría cobrado. */
    listPrice: bigint("list_price", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    /** Día contable local de la sede en que se dio la cortesía. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointment_courtesies_appointment_key").on(t.locationId, t.appointmentId),
    foreignKey({
      name: "appointment_courtesies_appointment_fk",
      columns: [t.locationId, t.appointmentId],
      foreignColumns: [appointments.locationId, appointments.id],
    }),
    foreignKey({
      name: "appointment_courtesies_staff_fk",
      columns: [t.locationId, t.staffId],
      foreignColumns: [staffMembers.locationId, staffMembers.id],
    }),
    check("appointment_courtesies_list_price_check", sql`${t.listPrice} >= 0 and ${wholePesos(t.listPrice)}`),
    check(
      "appointment_courtesies_reason_check",
      sql`char_length(${t.reason}) between 3 and 300 and ${t.reason} = btrim(${t.reason}) and ${t.reason} !~ '[[:cntrl:]]'`,
    ),
    index("appointment_courtesies_location_date_idx").on(t.locationId, t.businessDate),
  ],
);

// ─── Avisos al dueño (sprint 8, migración 0027) ──────────────────────────────
// docs/sprint-8-gastos-controles.md §3. El worker barre cada minuto lo que ya existe (anulaciones
// pedidas, cierres de caja por revisar, días reabiertos y cortesías) y deja aquí UNA fila por evento
// (UNIQUE location_id, kind, ref_id): repetir el barrido no duplica. Luego manda un correo agrupado
// por sede a ALERT_EMAIL y marca notified_at. No toca el camino del dinero: ni cash.ts, ni voids.ts,
// ni triggers en esas tablas. La app solo puede marcar notified_at (y una sola vez: trigger de 0027).

export const OWNER_ALERT_KINDS = ["void_requested", "cash_review", "day_reopened", "courtesy"] as const;

/** Un aviso al dueño: qué pasó (kind) y la fila de origen (ref_id, id interno de su tabla). */
export const ownerAlerts = pgTable(
  "owner_alerts",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    kind: text("kind", { enum: OWNER_ALERT_KINDS }).notNull(),
    /** void_requests.id, cash_sessions.id, day_close_events.id o appointment_courtesies.id según kind. */
    refId: bigint("ref_id", { mode: "bigint" }).notNull(),
    createdAt: createdAt(),
    /** Cuándo salió el correo que lo incluyó. Null: aún no sale (o no hay correo configurado). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    unique("owner_alerts_ref_key").on(t.locationId, t.kind, t.refId),
    check("owner_alerts_kind_check", sql`${t.kind} in ('void_requested','cash_review','day_reopened','courtesy')`),
    index("owner_alerts_pending_idx").on(t.locationId, t.id).where(sql`${t.notifiedAt} is null`),
  ],
);

// ─── Gastos fijos (sprint 8, migración 0028) ─────────────────────────────────
// docs/sprint-8-gastos-controles.md §5. Una plantilla (arriendo, servicios, internet) dice cuánto se
// estima, de dónde sale, qué día vence y cada cuántos meses. NADA se asienta solo: cada periodo se
// registra con el formulario de gasto normal (un gasto de `expenses`, con su asiento de siempre) o se
// omite con un motivo, y queda UNA fila en recurring_expense_runs (solo-inserción) por periodo.

/** Plantilla de gasto fijo. La app la edita (solo las columnas de la plantilla: grant de 0028). */
export const recurringExpenses = pgTable(
  "recurring_expenses",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    name: text("name").notNull(),
    categoryId: bigint("category_id", { mode: "bigint" }).notNull(),
    /** Monto estimado en centavos (pesos enteros), como `expenses.amount`. Al registrar se puede cambiar. */
    estimatedAmount: amount("estimated_amount").notNull(),
    payMode: text("pay_mode", { enum: ["cash", "bank"] }).notNull(),
    /** Día del mes en que vence (1 a 28: existe en todos los meses). */
    dayOfMonth: smallint("day_of_month").notNull(),
    /** Cada cuántos meses (1 a 12). */
    intervalMonths: smallint("interval_months").notNull(),
    /** Primer día del primer mes que se paga. */
    startMonth: date("start_month", { mode: "string" }).notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recurring_expenses_location_id_id_key").on(t.locationId, t.id),
    foreignKey({
      name: "recurring_expenses_category_fk",
      columns: [t.locationId, t.categoryId],
      foreignColumns: [expenseCategories.locationId, expenseCategories.id],
    }),
    check(
      "recurring_expenses_name_check",
      sql`char_length(${t.name}) between 3 and 60 and ${t.name} = btrim(${t.name}) and ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check("recurring_expenses_amount_check", sql`${t.estimatedAmount} > 0 and ${wholePesos(t.estimatedAmount)} and ${t.estimatedAmount} <= 10000000000000`),
    check("recurring_expenses_pay_mode_check", sql`${t.payMode} in ('cash','bank')`),
    check("recurring_expenses_day_check", sql`${t.dayOfMonth} between 1 and 28`),
    check("recurring_expenses_interval_check", sql`${t.intervalMonths} between 1 and 12`),
    check("recurring_expenses_start_month_check", sql`extract(day from ${t.startMonth}) = 1`),
    index("recurring_expenses_location_idx").on(t.locationId, t.active),
  ],
);

/**
 * Lo que pasó con un periodo de un gasto fijo: se registró (con su gasto) o se omitió (con el motivo).
 * Solo-inserción (sin UPDATE ni DELETE para la app, y triggers que lo prohíben a cualquiera). Un
 * periodo de una plantilla tiene a lo sumo una fila.
 */
export const recurringExpenseRuns = pgTable(
  "recurring_expense_runs",
  {
    id: id(),
    locationId: locationId().references(() => locations.id),
    recurringId: bigint("recurring_id", { mode: "bigint" }).notNull(),
    /** Primer día del mes del periodo. */
    period: date("period", { mode: "string" }).notNull(),
    outcome: text("outcome", { enum: ["registered", "skipped"] }).notNull(),
    /** El gasto que lo pagó (registered); null si se omitió. */
    expenseId: bigint("expense_id", { mode: "bigint" }),
    /** Por qué se omitió (skipped); null si se registró. */
    skipReason: text("skip_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recurring_expense_runs_period_key").on(t.locationId, t.recurringId, t.period),
    unique("recurring_expense_runs_expense_key").on(t.locationId, t.expenseId),
    foreignKey({
      name: "recurring_expense_runs_recurring_fk",
      columns: [t.locationId, t.recurringId],
      foreignColumns: [recurringExpenses.locationId, recurringExpenses.id],
    }),
    foreignKey({
      name: "recurring_expense_runs_expense_fk",
      columns: [t.locationId, t.expenseId],
      foreignColumns: [expenses.locationId, expenses.id],
    }),
    check("recurring_expense_runs_period_check", sql`extract(day from ${t.period}) = 1`),
    check(
      "recurring_expense_runs_outcome_check",
      sql`(${t.outcome} = 'registered' and ${t.expenseId} is not null and ${t.skipReason} is null)
        or (${t.outcome} = 'skipped' and ${t.expenseId} is null and ${t.skipReason} is not null
            and char_length(${t.skipReason}) between 3 and 300 and ${t.skipReason} = btrim(${t.skipReason}) and ${t.skipReason} !~ '[[:cntrl:]]')`,
    ),
  ],
);
