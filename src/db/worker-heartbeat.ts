import { and, eq, sql } from "drizzle-orm";
import { MINUTE_MS } from "@/domain/booking/clock";
import { pendingNotificationWhere } from "./notifications";
import { locations, notifications, workerHeartbeats } from "./schema";
import type { Db } from "./types";

// Latido del worker (migración 0030). El worker (src/worker/index.ts) escribe aquí cada minuto; la
// web lo lee para no prometer envíos que nadie está haciendo: si el latido tiene más de 5 minutos
// (o nunca hubo), los recibos y avisos quedan en cola hasta que el worker vuelva. Sin datos
// personales: solo el nombre del proceso y la hora.

/** El proceso que entrega los avisos (y corre los demás trabajos): `npm run worker`. */
export const WORKER_NAME = "worker";

/** Sin latido en este tiempo, el worker se da por detenido. Cron de 1 minuto: deja margen. */
export const HEARTBEAT_STALE_MS = 5 * MINUTE_MS;

/** El latido: una fila por proceso, solo cambia beat_at (lo único que villa_app puede actualizar). */
export async function recordHeartbeat(db: Db, now: Date = new Date(), name: string = WORKER_NAME): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ name, beatAt: now })
    .onConflictDoUpdate({ target: workerHeartbeats.name, set: { beatAt: now } });
}

/** SQL: true si el worker no ha latido en los últimos 5 minutos (o nunca). */
function workerDownSql(now: Date) {
  return sql<boolean>`not exists (
    select 1 from ${workerHeartbeats}
    where ${workerHeartbeats.name} = ${WORKER_NAME}
      and ${workerHeartbeats.beatAt} > ${new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString()}::timestamptz
  )`;
}

export interface DeliveryStatus {
  /** El latido está vencido (más de 5 minutos) o no existe. */
  workerDown: boolean;
  /** Worker detenido Y la sede tiene avisos pendientes de entregar: los envíos están detenidos. */
  stalled: boolean;
}

/**
 * Estado de los envíos de una sede, en UNA consulta: si el worker late y si hay avisos de la sede
 * esperando. "Pendiente" es la misma condición del barrido (pendingNotificationWhere). Sin datos
 * de clientes: solo dos booleanos.
 */
export async function deliveryStatus(db: Db, locationId: bigint, now: Date = new Date()): Promise<DeliveryStatus> {
  const pending = db
    .select({ one: sql`1` })
    .from(notifications)
    .where(and(eq(notifications.locationId, locationId), pendingNotificationWhere(now)));
  const [row] = await db
    .select({
      workerDown: workerDownSql(now),
      pending: sql<boolean>`exists (${pending})`,
    })
    .from(locations)
    .where(eq(locations.id, locationId));
  const workerDown = row ? row.workerDown === true : true;
  return { workerDown, stalled: workerDown && row?.pending === true };
}
