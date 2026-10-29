import { type AnyColumn, and, desc, eq, sql } from "drizzle-orm";
import { CONSENT_PURPOSES, type ConsentChoices, type ConsentPurpose, consentRows } from "@/domain/clients/consent";
import { privacyVersion } from "@/content/privacy/versions";
import { clientConsents } from "./schema";
import type { Db } from "./types";

// Autorizaciones de la Ley 1581. Solo-inserción (lo garantiza un trigger): cambiar de opinión
// es una fila nueva, y manda la última por cliente y propósito.

export async function recordConsents(
  db: Db,
  input: {
    locationId: bigint;
    clientId: bigint;
    appointmentId: bigint | null;
    choices: ConsentChoices;
    textVersion: string;
    ip: string | null;
    userAgent: string | null;
    source: "online" | "staff";
  },
): Promise<void> {
  if (!privacyVersion(input.textVersion)) throw new Error(`La versión de la política ${input.textVersion} no existe`);
  await db.insert(clientConsents).values(
    consentRows(input.choices).map((row) => ({
      locationId: input.locationId,
      clientId: input.clientId,
      appointmentId: input.appointmentId,
      purpose: row.purpose,
      granted: row.granted,
      textVersion: input.textVersion,
      ip: input.ip?.slice(0, 45) ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      source: input.source,
    })),
  );
}

/** Lo vigente por propósito (la última fila); sin filas, no hay consentimiento. */
export async function latestConsents(db: Db, input: { locationId: bigint; clientId: bigint }): Promise<Record<ConsentPurpose, boolean>> {
  const rows = await db
    .selectDistinctOn([clientConsents.purpose], { purpose: clientConsents.purpose, granted: clientConsents.granted })
    .from(clientConsents)
    .where(and(eq(clientConsents.locationId, input.locationId), eq(clientConsents.clientId, input.clientId)))
    .orderBy(clientConsents.purpose, desc(clientConsents.id));
  const out = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, false])) as Record<ConsentPurpose, boolean>;
  for (const r of rows) out[r.purpose] = r.granted;
  return out;
}

/** Condición SQL: el último consentimiento de `purpose` del cliente es verdadero. */
export function hasLatestConsent(purpose: ConsentPurpose, locationId: bigint | AnyColumn, clientId: bigint | AnyColumn) {
  const v = (x: bigint | AnyColumn) => (typeof x === "bigint" ? sql`${String(x)}::bigint` : sql`${x}`);
  return sql`coalesce((
    select cc.granted from client_consents cc
    where cc.location_id = ${v(locationId)} and cc.client_id = ${v(clientId)} and cc.purpose = ${purpose}
    order by cc.id desc limit 1
  ), false)`;
}
