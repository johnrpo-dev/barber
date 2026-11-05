import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { clientDevices, clients } from "./schema";
import type { Db } from "./types";

// Celular recordado en un navegador (cookie villa_device). Tras verificar el código una vez, el
// cliente vuelve a reservar desde ese dispositivo sin otro código: así la segunda reserva son tres
// toques. El token es aleatorio (256 bits) y la base guarda solo su SHA-256; un token desconocido,
// vencido, revocado, de otra sede o de un cliente sin celular o suprimido vale lo mismo: null.

export const DEVICE_COOKIE = "villa_device";
export const DEVICE_TTL_DAYS = 180;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string) => createHash("sha256").update(`villa:device:${token}`).digest("hex");

export function isDeviceTokenShape(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** Recuerda este navegador para el cliente; devuelve el token que va en la cookie. */
export async function rememberClientDevice(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(clientDevices).values({
    locationId: input.locationId,
    clientId: input.clientId,
    tokenHash: hashToken(token),
    expiresAt: new Date(input.now.getTime() + DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000),
  });
  return token;
}

export interface KnownClient {
  deviceId: bigint;
  clientId: bigint;
  name: string;
  phoneE164: string;
}

/** El cliente de este navegador, si el token sigue vigente. */
export async function knownClient(db: Db, input: { locationId: bigint; token: string | undefined | null; now: Date }): Promise<KnownClient | null> {
  if (!isDeviceTokenShape(input.token)) return null;
  const [row] = await db
    .select({ deviceId: clientDevices.id, clientId: clients.id, name: clients.name, phoneE164: clients.phoneE164 })
    .from(clientDevices)
    .innerJoin(clients, and(eq(clients.locationId, clientDevices.locationId), eq(clients.id, clientDevices.clientId)))
    .where(
      and(
        eq(clientDevices.locationId, input.locationId),
        eq(clientDevices.tokenHash, hashToken(input.token)),
        isNull(clientDevices.revokedAt),
        gt(clientDevices.expiresAt, input.now),
        isNull(clients.anonymizedAt),
        isNotNull(clients.phoneE164),
      ),
    )
    .limit(1);
  return row && row.phoneE164 ? { ...row, phoneE164: row.phoneE164 } : null;
}

export async function touchClientDevice(db: Db, input: { locationId: bigint; deviceId: bigint; now: Date }): Promise<void> {
  await db
    .update(clientDevices)
    .set({ lastUsedAt: input.now })
    .where(and(eq(clientDevices.locationId, input.locationId), eq(clientDevices.id, input.deviceId)));
}

/** "No soy yo": el token deja de servir. Un token mal formado o desconocido no hace nada. */
export async function forgetClientDevice(db: Db, input: { locationId: bigint; token: string | undefined | null }): Promise<void> {
  if (!isDeviceTokenShape(input.token)) return;
  await db
    .update(clientDevices)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(clientDevices.locationId, input.locationId), eq(clientDevices.tokenHash, hashToken(input.token)), isNull(clientDevices.revokedAt)));
}
