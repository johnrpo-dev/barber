import { and, desc, eq, lt, sql } from "drizzle-orm";
import { AUDIT_CATEGORY, type AuditAction, type AuditCategory, type AuditChange, type AuditValue, auditSummary, configChanges } from "@/domain/audit/events";
import { auditEvents, expenseCategories, locations, paymentMethods, services, staffMembers } from "./schema";
import type { Db } from "./types";

// Bitácora de auditoría (docs/sprint-5-comisiones-informes.md §8). recordAudit se llama DENTRO de la
// transacción de la escritura y solo cuando la operación se creó: una repetición por idempotencia no
// duplica el evento y una operación que falla no deja ninguno. Sin datos personales de clientes.

export interface AuditEventInput {
  locationId: bigint;
  actorUserId: string;
  /** Sin valor, se busca en la sede por el usuario (puede no haber: procesos del sistema). */
  actorStaffId?: bigint | null;
  action: AuditAction;
  targetKind: string;
  targetRef: string | null;
  summary: string;
  changes?: AuditChange[];
}

export async function recordAudit(tx: Db, event: AuditEventInput): Promise<void> {
  await tx.insert(auditEvents).values({
    locationId: event.locationId,
    actorUserId: event.actorUserId,
    actorStaffId:
      event.actorStaffId ??
      sql`(select m.id from staff_members m where m.location_id = ${event.locationId}::bigint and m.user_id = ${event.actorUserId} limit 1)`,
    action: event.action,
    category: AUDIT_CATEGORY[event.action],
    targetKind: event.targetKind,
    targetRef: event.targetRef,
    summary: auditSummary(event.summary),
    changes: event.changes && event.changes.length > 0 ? event.changes : null,
  });
}

/** Quién actúa, tal como lo da la sesión. Para las acciones que auditan con su propia transacción. */
export function auditActor(staff: { locationId: bigint; userId: string; staffId: bigint }) {
  return { locationId: staff.locationId, actorUserId: staff.userId, actorStaffId: staff.staffId };
}

/** Evento de configuración: `changes` son solo los campos de la lista blanca que cambiaron. */
export function recordConfigChange(
  tx: Db,
  event: Omit<AuditEventInput, "changes">,
  before: Record<string, AuditValue>,
  after: Record<string, AuditValue>,
  fields: readonly string[],
): Promise<void> {
  return recordAudit(tx, { ...event, changes: configChanges(before, after, fields) });
}

// ─── Fotos de configuración: el antes (FOR UPDATE) y el después de cada cambio ───────────────

const text = (v: number | bigint | string | null): string | null => (v === null ? null : v.toString());

export async function serviceSnapshot(tx: Db, locationId: bigint, serviceId: bigint): Promise<Record<string, AuditValue> | null> {
  const [row] = await tx
    .select({
      name: services.name,
      price: services.price,
      commissionBps: services.commissionBps,
      durationMin: services.durationMin,
      bufferMin: services.bufferMin,
      active: services.active,
    })
    .from(services)
    .where(and(eq(services.locationId, locationId), eq(services.id, serviceId)))
    .for("update");
  if (!row) return null;
  return {
    name: row.name,
    price: text(row.price),
    commissionBps: text(row.commissionBps),
    durationMin: text(row.durationMin),
    bufferMin: text(row.bufferMin),
    active: row.active,
  };
}

export async function paymentMethodSnapshot(tx: Db, locationId: bigint, id: bigint): Promise<Record<string, AuditValue> | null> {
  const [row] = await tx
    .select({ label: paymentMethods.label, feeBps: paymentMethods.feeBps, active: paymentMethods.active })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.locationId, locationId), eq(paymentMethods.id, id)))
    .for("update");
  return row ? { label: row.label, feeBps: text(row.feeBps), active: row.active } : null;
}

export async function expenseCategorySnapshot(tx: Db, locationId: bigint, id: bigint): Promise<Record<string, AuditValue> | null> {
  const [row] = await tx
    .select({ name: expenseCategories.name, accountCode: expenseCategories.accountCode, active: expenseCategories.active })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.locationId, locationId), eq(expenseCategories.id, id)))
    .for("update");
  return row ?? null;
}

export async function checkoutRulesSnapshot(tx: Db, locationId: bigint): Promise<Record<string, AuditValue>> {
  const [row] = await tx
    .select({
      commissionBase: locations.commissionBase,
      maxDiscountBps: locations.maxDiscountBps,
      receptionCanDiscount: locations.receptionCanDiscount,
      tipsBearCardFees: locations.tipsBearCardFees,
      cashReviewThreshold: locations.cashReviewThreshold,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .for("update");
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return {
    commissionBase: row.commissionBase,
    maxDiscountBps: text(row.maxDiscountBps),
    receptionCanDiscount: row.receptionCanDiscount,
    tipsBearCardFees: row.tipsBearCardFees,
    cashReviewThreshold: text(row.cashReviewThreshold),
  };
}

/** Sin el teléfono público: la lista blanca nunca lo incluye. */
export async function bookingSettingsSnapshot(tx: Db, locationId: bigint): Promise<Record<string, AuditValue>> {
  const [row] = await tx
    .select({
      publicBookingEnabled: locations.publicBookingEnabled,
      slotStepMin: locations.slotStepMin,
      minAdvanceMin: locations.minAdvanceMin,
      maxAdvanceDays: locations.maxAdvanceDays,
      holdMin: locations.holdMin,
      freeCancelHours: locations.freeCancelHours,
      noShowGraceMin: locations.noShowGraceMin,
      maxActivePerClient: locations.maxActivePerClient,
      address: locations.address,
      mapsUrl: locations.mapsUrl,
      receiptFooter: locations.receiptFooter,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .for("update");
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return {
    publicBookingEnabled: row.publicBookingEnabled,
    slotStepMin: text(row.slotStepMin),
    minAdvanceMin: text(row.minAdvanceMin),
    maxAdvanceDays: text(row.maxAdvanceDays),
    holdMin: text(row.holdMin),
    freeCancelHours: text(row.freeCancelHours),
    noShowGraceMin: text(row.noShowGraceMin),
    maxActivePerClient: text(row.maxActivePerClient),
    address: row.address,
    mapsUrl: row.mapsUrl,
    receiptFooter: row.receiptFooter,
  };
}

export async function staffSnapshot(tx: Db, locationId: bigint, staffId: bigint): Promise<Record<string, AuditValue> | null> {
  const [row] = await tx
    .select({ displayName: staffMembers.displayName, role: staffMembers.role, active: staffMembers.active, bookableOnline: staffMembers.bookableOnline })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.id, staffId)))
    .for("update");
  return row ?? null;
}

// ─── Visor ───────────────────────────────────────────────────────────────────

export interface AuditRow {
  id: bigint;
  occurredAt: Date;
  actorName: string | null;
  action: AuditAction;
  category: AuditCategory;
  targetKind: string;
  targetRef: string | null;
  summary: string;
  changes: AuditChange[];
}

/**
 * Lista de la sede, la más reciente primero. `before`: cursor por id. `from` y `to` son días
 * contables de la sede (inclusive); se comparan como instantes para usar el índice por fecha.
 */
export async function auditLog(
  db: Db,
  input: { locationId: bigint; before?: bigint; from?: string; to?: string; category?: AuditCategory; limit: number },
): Promise<AuditRow[]> {
  const tz = sql`(select l.timezone from locations l where l.id = ${input.locationId}::bigint)`;
  const rows = await db
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      actorName: staffMembers.displayName,
      action: auditEvents.action,
      category: auditEvents.category,
      targetKind: auditEvents.targetKind,
      targetRef: auditEvents.targetRef,
      summary: auditEvents.summary,
      changes: auditEvents.changes,
    })
    .from(auditEvents)
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, auditEvents.locationId), eq(staffMembers.id, auditEvents.actorStaffId)))
    .where(
      and(
        eq(auditEvents.locationId, input.locationId),
        input.before === undefined ? undefined : lt(auditEvents.id, input.before),
        input.category === undefined ? undefined : eq(auditEvents.category, input.category),
        input.from === undefined ? undefined : sql`${auditEvents.occurredAt} >= (${input.from}::date)::timestamp at time zone ${tz}`,
        input.to === undefined ? undefined : sql`${auditEvents.occurredAt} < ((${input.to}::date + 1)::timestamp at time zone ${tz})`,
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(input.limit);
  return rows.map((r) => ({ ...r, action: r.action as AuditAction, changes: (r.changes ?? []) as AuditChange[] }));
}
