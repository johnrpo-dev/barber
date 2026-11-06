import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { AppointmentStatus } from "@/domain/booking/status";
import type { ConsentPurpose } from "@/domain/clients/consent";
import type { NoShowStanding } from "@/domain/clients/no-shows";
import { clientDeviceSummary } from "./client-devices";
import { type LatestConsentRow, latestConsentRecords } from "./consents";
import { noShowStandingOf } from "./no-shows";
import { appointments, clients, staffMembers } from "./schema";
import type { Db } from "./types";

// Ficha del cliente en el panel (sprint 7): datos básicos, historial, faltas, autorizaciones
// vigentes y navegadores recordados. Los conteos se suman en SQL; el historial trae solo las últimas.

/** Cuántas citas se muestran en la ficha (las más recientes). */
export const CLIENT_HISTORY_LIMIT = 20;

export interface ClientRecord {
  id: bigint;
  name: string;
  phoneE164: string | null;
  email: string | null;
  verified: boolean;
  createdAt: Date;
  counts: { total: number; completed: number; noShows: number; cancelled: number; upcoming: number };
  history: { id: bigint; start: Date; serviceName: string; staffName: string; status: AppointmentStatus }[];
  noShows: NoShowStanding;
  consents: Partial<Record<ConsentPurpose, LatestConsentRow>>;
  devices: { active: number; lastUsedAt: Date | null };
}

/** null si no existe en la sede o sus datos ya se suprimieron. */
export async function clientRecord(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<ClientRecord | null> {
  const nowIso = input.now.toISOString();
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.name,
      phoneE164: clients.phoneE164,
      email: clients.email,
      verifiedAt: clients.verifiedAt,
      createdAt: clients.createdAt,
      // Con alias y a mano: en un select de una sola tabla, Drizzle quita el nombre de la tabla a sus columnas.
      total: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id and a.status <> 'pending')`,
      completed: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id and a.status = 'completed')`,
      noShows: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id and a.status = 'no_show')`,
      cancelled: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id and a.status = 'cancelled')`,
      upcoming: sql<string>`(select count(*) from appointments a where a.location_id = clients.location_id and a.client_id = clients.id
        and a.status in ('confirmed', 'arrived', 'in_chair') and upper(a.during) > ${nowIso}::timestamptz)`,
    })
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId), sql`${clients.anonymizedAt} is null`));
  if (!row) return null;

  const history = await db
    .select({
      id: appointments.id,
      during: appointments.during,
      serviceName: appointments.serviceName,
      staffName: staffMembers.displayName,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, appointments.locationId), eq(staffMembers.id, appointments.staffId)))
    .where(and(eq(appointments.locationId, input.locationId), eq(appointments.clientId, input.clientId), ne(appointments.status, "pending")))
    .orderBy(desc(sql`lower(${appointments.during})`), desc(appointments.id))
    .limit(CLIENT_HISTORY_LIMIT);

  const noShows = await noShowStandingOf(db, { locationId: input.locationId, clientId: input.clientId, now: input.now });
  return {
    id: row.id,
    name: row.name,
    phoneE164: row.phoneE164,
    email: row.email,
    verified: row.verifiedAt !== null,
    createdAt: row.createdAt,
    counts: {
      total: Number(row.total),
      completed: Number(row.completed),
      noShows: Number(row.noShows),
      cancelled: Number(row.cancelled),
      upcoming: Number(row.upcoming),
    },
    history: history.map((h) => ({ id: h.id, start: h.during.start, serviceName: h.serviceName, staffName: h.staffName, status: h.status })),
    noShows: noShows ?? { count: 0, limit: 0, suspended: false },
    consents: await latestConsentRecords(db, input),
    devices: await clientDeviceSummary(db, input),
  };
}
