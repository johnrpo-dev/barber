import { and, asc, eq, sql } from "drizzle-orm";
import { assertValidService, type ServiceDraft } from "@/domain/catalog/service";
import { money, type Money } from "@/domain/money";
import { services } from "./schema";
import type { Db } from "./types";

// Catálogo de servicios. Cambiar un precio o una comisión aquí no toca ventas pasadas:
// cada venta copia precio y comisión al momento de cobrar.

export interface Service {
  id: bigint;
  name: string;
  durationMin: number;
  bufferMin: number;
  price: Money;
  commissionBps: number;
  active: boolean;
}

const columns = {
  id: services.id,
  name: services.name,
  durationMin: services.durationMin,
  bufferMin: services.bufferMin,
  price: services.price,
  commissionBps: services.commissionBps,
  active: services.active,
};

function toService(row: { price: bigint } & Omit<Service, "price">): Service {
  return { ...row, price: money(row.price) };
}

function values(draft: ServiceDraft) {
  assertValidService(draft);
  return {
    name: draft.name.trim(),
    durationMin: draft.durationMin,
    bufferMin: draft.bufferMin,
    price: draft.price.minor,
    commissionBps: draft.commissionBps,
  };
}

export async function createService(db: Db, input: { locationId: bigint; draft: ServiceDraft }): Promise<Service> {
  const [row] = await db
    .insert(services)
    .values({ locationId: input.locationId, ...values(input.draft) })
    .returning(columns);
  if (!row) throw new Error("No se pudo crear el servicio");
  return toService(row);
}

export async function updateService(
  db: Db,
  input: { locationId: bigint; serviceId: bigint; draft: ServiceDraft },
): Promise<Service> {
  const [row] = await db
    .update(services)
    .set({ ...values(input.draft), updatedAt: sql`now()` })
    .where(and(eq(services.locationId, input.locationId), eq(services.id, input.serviceId)))
    .returning(columns);
  if (!row) throw new Error(`El servicio ${input.serviceId} no existe en la sede ${input.locationId}`);
  return toService(row);
}

/** Retirar un servicio del catálogo sin borrarlo (las ventas pasadas lo siguen nombrando). */
export async function setServiceActive(
  db: Db,
  input: { locationId: bigint; serviceId: bigint; active: boolean },
): Promise<void> {
  const updated = await db
    .update(services)
    .set({ active: input.active, updatedAt: sql`now()` })
    .where(and(eq(services.locationId, input.locationId), eq(services.id, input.serviceId)))
    .returning({ id: services.id });
  if (updated.length === 0) throw new Error(`El servicio ${input.serviceId} no existe en la sede ${input.locationId}`);
}

/** Un servicio de la sede, o null si no existe en esa sede. */
export async function serviceOf(
  db: Db,
  input: { locationId: bigint; serviceId: bigint; forUpdate?: boolean },
): Promise<Service | null> {
  const query = db
    .select(columns)
    .from(services)
    .where(and(eq(services.locationId, input.locationId), eq(services.id, input.serviceId)));
  const [row] = input.forUpdate ? await query.for("update") : await query;
  return row ? toService(row) : null;
}

export async function listServices(
  db: Db,
  input: { locationId: bigint; includeInactive?: boolean },
): Promise<Service[]> {
  const where = input.includeInactive
    ? eq(services.locationId, input.locationId)
    : and(eq(services.locationId, input.locationId), eq(services.active, true));
  const rows = await db.select(columns).from(services).where(where).orderBy(asc(services.name));
  return rows.map(toService);
}
