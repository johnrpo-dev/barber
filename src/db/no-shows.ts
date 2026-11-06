import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { InvalidClientError } from "@/domain/clients/client";
import { NO_SHOW_WINDOW_DAYS, type NoShowStanding, noShowStanding } from "@/domain/clients/no-shows";
import { recordAudit } from "./audit";
import { appointments, clients, locations } from "./schema";
import type { Db } from "./types";

// Faltas y la reserva en línea (src/domain/clients/no-shows.ts). Las horas de las faltas
// (status_changed_at) y del desbloqueo (no_shows_cleared_at) las pone el reloj de la base, así que
// se comparan entre sí sin depender del reloj del servidor web; ese solo pone el tope `now` y la
// ventana de 180 días (un desfase de segundos entre los dos relojes no cambia nada útil).
// now() de Postgres es la hora de inicio de la transacción: un "No vino" que empezó antes de un
// desbloqueo y confirma después queda perdonado. Es raro y a favor del cliente; se acepta.

/** Cuántas faltas cuentan para cada cliente y si tiene la reserva en línea suspendida. */
export async function noShowStandings(
  db: Db,
  input: { locationId: bigint; clientIds: readonly bigint[]; now: Date },
): Promise<Map<bigint, NoShowStanding>> {
  const out = new Map<bigint, NoShowStanding>();
  const ids = [...new Set(input.clientIds)];
  if (ids.length === 0) return out;
  const [loc] = await db.select({ limit: locations.noShowLimit }).from(locations).where(eq(locations.id, input.locationId));
  if (!loc) throw new Error(`La sede ${input.locationId} no existe`);
  const people = await db
    .select({ id: clients.id, clearedAt: clients.noShowsClearedAt })
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), inArray(clients.id, ids)));
  const marks = await db
    .select({ clientId: appointments.clientId, at: appointments.statusChangedAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.locationId, input.locationId),
        inArray(appointments.clientId, ids),
        eq(appointments.status, "no_show"),
        gt(appointments.statusChangedAt, sql`${input.now.toISOString()}::timestamptz - make_interval(days => ${NO_SHOW_WINDOW_DAYS})`),
      ),
    );
  for (const p of people) {
    const markedAt = marks.filter((m) => m.clientId === p.id).map((m) => m.at);
    out.set(p.id, noShowStanding({ markedAt, clearedAt: p.clearedAt, now: input.now, limit: loc.limit }));
  }
  return out;
}

export async function noShowStandingOf(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<NoShowStanding | null> {
  return (await noShowStandings(db, { ...input, clientIds: [input.clientId] })).get(input.clientId) ?? null;
}

/**
 * Desbloquea la reserva en línea: desde ahora las faltas anteriores dejan de contar. Recepción o
 * el dueño (decisión del dueño, sprint 7). Queda en la bitácora sin datos de la persona.
 */
export async function clearNoShows(
  db: Db,
  input: { locationId: bigint; clientId: bigint; actor: { userId: string; staffId: bigint }; now: Date },
): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [client] = await tx
      .select({ id: clients.id, anonymizedAt: clients.anonymizedAt })
      .from(clients)
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)))
      .for("update");
    if (!client || client.anonymizedAt) throw new InvalidClientError("El cliente no existe en esta sede");
    const standing = await noShowStandingOf(tx, input);
    if (!standing?.suspended) throw new InvalidClientError("Este cliente ya puede reservar en línea");
    await tx
      .update(clients)
      .set({ noShowsClearedAt: sql`now()`, updatedAt: input.now })
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)));
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "client.no_shows_clear",
      targetKind: "client",
      targetRef: input.clientId.toString(),
      summary: `Desbloqueó la reserva en línea de un cliente (${standing.count} faltas)`,
    });
  });
}
