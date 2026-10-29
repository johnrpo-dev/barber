import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { deriveManageToken, hashManageToken, isManageTokenShape, manageLinkExpiry } from "@/domain/links/manage-token";
import { appointmentLinks, appointments } from "./schema";
import type { Db } from "./types";

// Enlaces de gestión (/cita/[token]). El token se deriva de publicId + generación con
// MANAGE_LINK_SECRET; la base guarda solo su SHA-256. Desconocido, vencido, revocado o de otra
// sede: null, y la página muestra el mismo 404 para todo.

const hex = (token: string) => hashManageToken(token).toString("hex");

/** Crea el enlace vigente de la cita (o devuelve el que ya existe) y su token. */
export async function issueManageLink(
  db: Db,
  input: { locationId: bigint; appointmentId: bigint; publicId: string; appointmentEnd: Date; secret: string },
): Promise<string> {
  const [active] = await db
    .select({ generation: appointmentLinks.generation })
    .from(appointmentLinks)
    .where(and(eq(appointmentLinks.appointmentId, input.appointmentId), isNull(appointmentLinks.revokedAt)));
  if (active) return deriveManageToken(input.secret, input.publicId, active.generation);

  const [last] = await db
    .select({ generation: sql<number>`coalesce(max(${appointmentLinks.generation}), -1)::int` })
    .from(appointmentLinks)
    .where(eq(appointmentLinks.appointmentId, input.appointmentId));
  const generation = Number(last?.generation ?? -1) + 1;
  const token = deriveManageToken(input.secret, input.publicId, generation);
  await db.insert(appointmentLinks).values({
    locationId: input.locationId,
    appointmentId: input.appointmentId,
    tokenHash: hex(token),
    generation,
    expiresAt: manageLinkExpiry(input.appointmentEnd),
  });
  return token;
}

export interface ManagedAppointment {
  linkId: bigint;
  generation: number;
  revoked: boolean;
  appointmentId: bigint;
  publicId: string;
}

/**
 * Busca la cita por el token. Primero la forma (barato, sin tocar la base), luego el hash.
 * `allowRevoked`: solo para que cancelar dos veces sea un no-op; la página nunca lo usa.
 */
export async function findByManageToken(
  db: Db,
  input: { locationId: bigint; token: string; now: Date; allowRevoked?: boolean },
): Promise<ManagedAppointment | null> {
  if (!isManageTokenShape(input.token)) return null;
  const [row] = await db
    .select({
      linkId: appointmentLinks.id,
      generation: appointmentLinks.generation,
      revokedAt: appointmentLinks.revokedAt,
      revokedReason: appointmentLinks.revokedReason,
      appointmentId: appointments.id,
      publicId: appointments.publicId,
    })
    .from(appointmentLinks)
    .innerJoin(appointments, and(eq(appointments.locationId, appointmentLinks.locationId), eq(appointments.id, appointmentLinks.appointmentId)))
    .where(
      and(
        eq(appointmentLinks.tokenHash, hex(input.token)),
        eq(appointmentLinks.locationId, input.locationId),
        gt(appointmentLinks.expiresAt, input.now),
      ),
    );
  if (!row) return null;
  if (row.revokedAt && !(input.allowRevoked && row.revokedReason === "cancelled")) return null;
  return { linkId: row.linkId, generation: row.generation, revoked: row.revokedAt !== null, appointmentId: row.appointmentId, publicId: row.publicId };
}

/** Al cancelar: el enlace deja de servir (en la misma transacción de la cancelación). */
export async function revokeManageLinks(
  db: Db,
  input: { locationId: bigint; appointmentId: bigint; reason: "cancelled" | "rotated" | "staff"; now: Date },
): Promise<void> {
  await db
    .update(appointmentLinks)
    .set({ revokedAt: input.now, revokedReason: input.reason })
    .where(
      and(
        eq(appointmentLinks.locationId, input.locationId),
        eq(appointmentLinks.appointmentId, input.appointmentId),
        isNull(appointmentLinks.revokedAt),
      ),
    );
}

/** Al reprogramar: el token no cambia, el vencimiento sigue al nuevo fin de la cita. */
export async function extendManageLink(db: Db, input: { locationId: bigint; appointmentId: bigint; appointmentEnd: Date }): Promise<void> {
  await db
    .update(appointmentLinks)
    .set({ expiresAt: manageLinkExpiry(input.appointmentEnd) })
    .where(
      and(
        eq(appointmentLinks.locationId, input.locationId),
        eq(appointmentLinks.appointmentId, input.appointmentId),
        isNull(appointmentLinks.revokedAt),
      ),
    );
}

/** Generación vigente del enlace de una cita (para recalcular el token en los recordatorios). */
export async function activeLinkGeneration(db: Db, input: { locationId: bigint; appointmentId: bigint }): Promise<number | null> {
  const [row] = await db
    .select({ generation: appointmentLinks.generation })
    .from(appointmentLinks)
    .where(
      and(
        eq(appointmentLinks.locationId, input.locationId),
        eq(appointmentLinks.appointmentId, input.appointmentId),
        isNull(appointmentLinks.revokedAt),
      ),
    );
  return row ? row.generation : null;
}
