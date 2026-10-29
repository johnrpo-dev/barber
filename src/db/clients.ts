import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { assertValidClientName, InvalidClientError, normalizePhone } from "@/domain/clients/client";
import { clients } from "./schema";
import type { Db } from "./types";

export interface ClientSummary {
  id: bigint;
  name: string;
  phoneE164: string | null;
}

const columns = { id: clients.id, name: clients.name, phoneE164: clients.phoneE164 };

/** Busca por nombre o por celular (con cualquier formato). Máximo 8 resultados. */
export async function searchClients(db: Db, input: { locationId: bigint; query: string }): Promise<ClientSummary[]> {
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
    .limit(8);
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
