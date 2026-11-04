import { sql } from "drizzle-orm";
import { type ContactReadContext, contactReadKey, readWindowStart } from "@/domain/clients/retention";
import { personalDataReads } from "./schema";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Datos personales (Ley 1581): purga de lo vencido y auditoría de lecturas de contactos.
// Las reglas viven en la base (migración 0012): aquí solo se llaman.

export interface PurgeResult {
  verifications: number;
  notifications: number;
  reads: number;
}

/**
 * Mantenimiento diario: purge_expired_personal_data() (SECURITY DEFINER, dueña villa_owner) borra
 * la IP, el navegador, el nombre y el correo de los códigos viejos, vacía los params de los avisos
 * viejos y borra la auditoría de lecturas vencida. No recibe fechas: solo hace lo que ya venció.
 */
export async function purgeExpiredPersonalData(db: Db): Promise<PurgeResult> {
  const [row] = rowsOf<{ purged_verifications: number; purged_notifications: number; purged_reads: number }>(
    await db.execute(sql`select purged_verifications, purged_notifications, purged_reads from purge_expired_personal_data()`),
  );
  return {
    verifications: Number(row?.purged_verifications ?? 0),
    notifications: Number(row?.purged_notifications ?? 0),
    reads: Number(row?.purged_reads ?? 0),
  };
}

/**
 * Deja constancia de que alguien del personal vio el celular completo de estos clientes. Una fila
 * por (persona, pantalla, conjunto de clientes, ventana de 10 minutos): recargar no la repite.
 */
export async function recordContactReads(
  db: Db,
  input: { locationId: bigint; staffId: bigint; context: ContactReadContext; clientIds: readonly bigint[]; now?: Date },
): Promise<void> {
  const key = contactReadKey(input.clientIds);
  if (!key) return;
  await db
    .insert(personalDataReads)
    .values({
      locationId: input.locationId,
      staffId: input.staffId,
      context: input.context,
      clientIds: key.clientIds,
      clientsHash: key.clientsHash,
      windowStart: readWindowStart(input.now ?? new Date()),
    })
    .onConflictDoNothing();
}
