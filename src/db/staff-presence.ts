import { and, desc, eq, gte } from "drizzle-orm";
import type { StaffPresence } from "@/domain/booking/walk-in-queue";
import { staffMembers, staffPresenceEvents } from "./schema";
import { StaffError } from "./staff";
import type { Db } from "./types";

// "Salí / Llegué" (decisión del dueño, sprint 7): quien sale queda fuera de la fila del walk-in hasta
// que llega y, al volver, entra de último. No toca la agenda ni la reserva en línea: una diligencia
// de veinte minutos no le quita los turnos del resto del día. Solo-inserción: manda la última marca
// de hoy y el historial dice quién marcó a quién. Cada día empieza en la barbería: una salida que
// nadie cerró ayer no lo deja fuera hoy. La hora la pone la base (at = now()).

export type PresenceKind = "out" | "in";

/** La presencia de hoy de cada barbero con marcas (desde `dayStart`, el inicio del día de la sede). */
export async function presenceToday(db: Db, input: { locationId: bigint; dayStart: Date }): Promise<Map<bigint, StaffPresence>> {
  const rows = await db
    .select({ staffId: staffPresenceEvents.staffId, kind: staffPresenceEvents.kind, at: staffPresenceEvents.at })
    .from(staffPresenceEvents)
    .where(and(eq(staffPresenceEvents.locationId, input.locationId), gte(staffPresenceEvents.at, input.dayStart)))
    .orderBy(staffPresenceEvents.staffId, desc(staffPresenceEvents.id));
  const out = new Map<bigint, StaffPresence>();
  for (const r of rows) {
    // Por persona, la primera fila es la más reciente: decide si está fuera.
    if (!out.has(r.staffId)) out.set(r.staffId, r.kind === "out" ? { outSince: r.at, backAt: null } : { outSince: null, backAt: r.at });
  }
  return out;
}

/**
 * Marca que salió o que llegó. Repetir la marca vigente no hace nada (doble toque, dos recepcionistas
 * a la vez), y "Llegué" sin haber salido hoy tampoco. La fila del barbero queda bloqueada para que dos
 * marcas simultáneas no se crucen.
 */
export async function markPresence(
  db: Db,
  input: { locationId: bigint; staffId: bigint; kind: PresenceKind; dayStart: Date; createdBy: string },
): Promise<{ changed: boolean }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [member] = await tx
      .select({ id: staffMembers.id })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId), eq(staffMembers.active, true)))
      .for("update");
    if (!member) throw new StaffError("La persona no existe en esta sede");
    const isOut = !!(await presenceToday(tx, { locationId: input.locationId, dayStart: input.dayStart })).get(input.staffId)?.outSince;
    if ((input.kind === "out") === isOut) return { changed: false };
    await tx.insert(staffPresenceEvents).values({ locationId: input.locationId, staffId: input.staffId, kind: input.kind, createdBy: input.createdBy });
    return { changed: true };
  });
}
