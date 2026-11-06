import { type AnyColumn, and, desc, eq, sql } from "drizzle-orm";
import { InvalidClientError } from "@/domain/clients/client";
import {
  CONSENT_PURPOSE_LABELS,
  type ConsentChoices,
  type ConsentPurpose,
  type ConsentRecord,
  consentRows,
  WITHDRAWABLE_PURPOSES,
  type WithdrawablePurpose,
} from "@/domain/clients/consent";
import { CURRENT_PRIVACY_VERSION, privacyVersion, versionsSince } from "@/content/privacy/versions";
import { recordAudit } from "./audit";
import { clientConsents, clients } from "./schema";
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

export interface LatestConsentRow extends ConsentRecord {
  purpose: ConsentPurpose;
  createdAt: Date;
}

/** La última fila de cada propósito, con su versión, su origen y su fecha (para la ficha y la renovación). */
export async function latestConsentRecords(db: Db, input: { locationId: bigint; clientId: bigint }): Promise<Partial<Record<ConsentPurpose, LatestConsentRow>>> {
  const rows = await db
    .selectDistinctOn([clientConsents.purpose], {
      purpose: clientConsents.purpose,
      granted: clientConsents.granted,
      textVersion: clientConsents.textVersion,
      source: clientConsents.source,
      createdAt: clientConsents.createdAt,
    })
    .from(clientConsents)
    .where(and(eq(clientConsents.locationId, input.locationId), eq(clientConsents.clientId, input.clientId)))
    .orderBy(clientConsents.purpose, desc(clientConsents.id));
  return Object.fromEntries(rows.map((r) => [r.purpose, r]));
}

/**
 * El personal retira el recordatorio o las promociones a pedido del cliente (Ley 1581: derecho a
 * revocar). Una fila nueva `granted = false`, `source = 'staff'`, con la versión vigente de la
 * política; nada se edita ni se borra. En la misma transacción queda el evento de la bitácora, sin
 * datos de la persona (solo el propósito). Si ya no estaba vigente, no escribe nada.
 */
export async function withdrawConsent(
  db: Db,
  input: { locationId: bigint; clientId: bigint; purpose: WithdrawablePurpose; actor: { userId: string; staffId: bigint } },
): Promise<void> {
  if (!(WITHDRAWABLE_PURPOSES as readonly string[]).includes(input.purpose)) throw new InvalidClientError("Esa autorización no se retira desde aquí");
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // El cliente bloqueado: dos retiros a la vez no dejan dos filas ni dos eventos.
    const [client] = await tx
      .select({ id: clients.id, anonymizedAt: clients.anonymizedAt })
      .from(clients)
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)))
      .for("update");
    if (!client || client.anonymizedAt) throw new InvalidClientError("El cliente no existe en esta sede");
    const latest = await latestConsentRecords(tx, input);
    if (!latest[input.purpose]?.granted) throw new InvalidClientError("Este cliente no tiene esa autorización vigente");
    await tx.insert(clientConsents).values({
      locationId: input.locationId,
      clientId: input.clientId,
      appointmentId: null,
      purpose: input.purpose,
      granted: false,
      textVersion: CURRENT_PRIVACY_VERSION,
      ip: null,
      userAgent: null,
      source: "staff",
    });
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "client.consent_withdraw",
      targetKind: "client",
      targetRef: input.clientId.toString(),
      summary: `Retiró la autorización de un cliente: ${CONSENT_PURPOSE_LABELS[input.purpose].toLowerCase()}`,
    });
  });
}

/**
 * Renovación del cliente recordado que autorizó con una política anterior (renewalRows): filas
 * nuevas con la versión vigente, dentro de la transacción de la reserva. `source = 'online'`: la
 * marcó la persona en el portal.
 */
export async function recordConsentRenewal(
  tx: Db,
  input: {
    locationId: bigint;
    clientId: bigint;
    appointmentId: bigint;
    rows: readonly { purpose: ConsentPurpose; granted: boolean }[];
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  if (input.rows.length === 0) return;
  await tx.insert(clientConsents).values(
    input.rows.map((row) => ({
      locationId: input.locationId,
      clientId: input.clientId,
      appointmentId: input.appointmentId,
      purpose: row.purpose,
      granted: row.granted,
      textVersion: CURRENT_PRIVACY_VERSION,
      ip: input.ip?.slice(0, 45) ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      source: "online" as const,
    })),
  );
}

/**
 * Condición SQL: el último consentimiento de `purpose` del cliente es verdadero. Con
 * `sinceVersion`, además tiene que haberse dado con esa versión de la política o una posterior
 * (una revocación posterior, de cualquier versión, sigue mandando).
 */
export function hasLatestConsent(purpose: ConsentPurpose, locationId: bigint | AnyColumn, clientId: bigint | AnyColumn, opts: { sinceVersion?: string } = {}) {
  const v = (x: bigint | AnyColumn) => (typeof x === "bigint" ? sql`${String(x)}::bigint` : sql`${x}`);
  const granted = opts.sinceVersion
    ? sql`(cc.granted and cc.text_version in (${sql.join(
        versionsSince(opts.sinceVersion).map((x) => sql`${x}`),
        sql`, `,
      )}))`
    : sql`cc.granted`;
  return sql`coalesce((
    select ${granted} from client_consents cc
    where cc.location_id = ${v(locationId)} and cc.client_id = ${v(clientId)} and cc.purpose = ${purpose}
    order by cc.id desc limit 1
  ), false)`;
}
