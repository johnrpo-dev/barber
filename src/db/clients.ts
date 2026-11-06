import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { assertValidClientName, InvalidClientError, normalizePhone } from "@/domain/clients/client";
import { recordAudit } from "./audit";
import { appointments, clients } from "./schema";
import { serializable } from "./serializable";
import type { Db } from "./types";

export interface ClientSummary {
  id: bigint;
  name: string;
  phoneE164: string | null;
}

const columns = { id: clients.id, name: clients.name, phoneE164: clients.phoneE164 };

/** Busca por nombre o por celular (con cualquier formato). Máximo 8 resultados. */
export const CLIENT_SEARCH_LIMIT = 8;

export async function searchClients(db: Db, input: { locationId: bigint; query: string; limit?: number }): Promise<ClientSummary[]> {
  const q = input.query.trim();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, "");
  const byName = ilike(clients.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  const where = digits.length >= 3 ? or(byName, sql`${clients.phoneE164} like ${`%${digits}%`}`) : byName;
  return db
    .select(columns)
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), sql`${clients.anonymizedAt} is null`, where))
    .orderBy(asc(clients.name))
    .limit(input.limit ?? CLIENT_SEARCH_LIMIT);
}

/** Si el celular ya existe en la sede, devuelve ese cliente (no duplica); si no, lo crea. */
export async function findOrCreateClient(
  db: Db,
  input: { locationId: bigint; name: string; phone: string },
): Promise<ClientSummary> {
  const name = assertValidClientName(input.name);
  const phoneE164 = normalizePhone(input.phone);
  if (!phoneE164) throw new InvalidClientError("El celular no es válido (ej. 300 123 4567)");

  const [created] = await db
    .insert(clients)
    .values({ locationId: input.locationId, name, phoneE164 })
    .onConflictDoNothing({ target: [clients.locationId, clients.phoneE164], where: sql`${clients.phoneE164} is not null` })
    .returning(columns);
  if (created) return created;

  const [existing] = await db
    .select(columns)
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), eq(clients.phoneE164, phoneE164)));
  if (!existing) throw new Error("No se pudo crear ni encontrar el cliente");
  return existing;
}

/**
 * Ley 1581 (minimización): clientes que iniciaron una reserva en línea y nunca confirmaron el
 * código. A los 7 días, si todas sus citas son retenciones vencidas o reemplazadas, se borran
 * su nombre, celular y correo. Lo corre el mantenimiento diario.
 */
export async function anonymizeNeverVerifiedClients(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await db
    .update(clients)
    .set({ name: "Anónimo", phoneE164: null, email: null, anonymizedAt: now, updatedAt: now })
    .where(
      and(
        sql`${clients.verifiedAt} is null`,
        sql`${clients.anonymizedAt} is null`,
        sql`${clients.createdAt} < ${cutoff}::timestamptz`,
        sql`exists (select 1 from appointments a where a.location_id = ${clients.locationId} and a.client_id = ${clients.id} and a.source = 'online')`,
        sql`not exists (
          select 1 from appointments a
          where a.location_id = ${clients.locationId} and a.client_id = ${clients.id}
            and not (a.status = 'cancelled' and a.cancel_reason in ('expired', 'duplicate'))
        )`,
      ),
    )
    .returning({ id: clients.id });
  return rows.length;
}

export async function getClient(db: Db, input: { locationId: bigint; clientId: bigint }): Promise<ClientSummary | undefined> {
  const [row] = await db
    .select(columns)
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)));
  return row;
}

// ─── Supresión a solicitud del titular (Ley 1581; docs/sprint-5-comisiones-informes.md §12.8) ──

/** Citas que todavía pueden avisarle algo o pasar por caja: mientras existan, no se suprime. */
const activeAppointment = sql`${appointments.status} in ('pending', 'confirmed', 'arrived', 'in_chair')`;

export interface ClientErasePreview {
  id: bigint;
  name: string;
  phoneE164: string | null;
  email: string | null;
  appointments: number;
  activeAppointments: number;
  sales: number;
}

/** Lo que el dueño confirma antes de suprimir. null si no existe o ya se suprimió. */
export async function clientErasePreview(db: Db, input: { locationId: bigint; clientId: bigint }): Promise<ClientErasePreview | null> {
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.name,
      phoneE164: clients.phoneE164,
      email: clients.email,
      // Con alias y a mano: en un select de una sola tabla, Drizzle quita el nombre de la tabla a sus columnas.
      appointments: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id)`,
      activeAppointments: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id and a.status in ('pending', 'confirmed', 'arrived', 'in_chair'))`,
      sales: sql<string>`(select count(*) from sales s where s.location_id = clients.location_id and s.client_id = clients.id)`,
    })
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId), sql`${clients.anonymizedAt} is null`));
  if (!row) return null;
  return { ...row, appointments: Number(row.appointments), activeAppointments: Number(row.activeAppointments), sales: Number(row.sales) };
}

/**
 * Suprime los datos personales de un cliente en una transacción: la función de la base
 * (erase_client_personal_data, 0013) anonimiza y borra el texto libre; el libro y las ventas quedan
 * intactos, con la venta apuntando al cliente anónimo. El evento de la bitácora no lleva ningún dato
 * de la persona: es también la lista para volver a aplicar la supresión tras restaurar una copia.
 */
export async function eraseClient(db: Db, input: { locationId: bigint; clientId: bigint; actor: { userId: string; staffId: bigint } }): Promise<void> {
  await serializable(db, async (tx) => {
    const [client] = await tx
      .select({ anonymizedAt: clients.anonymizedAt })
      .from(clients)
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)))
      .for("update");
    if (!client) throw new InvalidClientError("El cliente no existe");
    if (client.anonymizedAt) throw new InvalidClientError("Los datos de este cliente ya se suprimieron");
    const [active] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(appointments)
      .where(and(eq(appointments.locationId, input.locationId), eq(appointments.clientId, input.clientId), activeAppointment));
    if (Number(active!.n) > 0) throw new InvalidClientError("Este cliente tiene citas activas: cancélalas o termínalas primero");
    await tx.execute(sql`select erase_client_personal_data(${input.locationId}::bigint, ${input.clientId}::bigint)`);
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "client.erase",
      targetKind: "client",
      targetRef: input.clientId.toString(),
      summary: "Suprimió los datos personales de un cliente a su solicitud",
    });
  });
}
