import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { InvalidClientError } from "@/domain/clients/client";
import { DEVICE_PURGE_DAYS, devicesToRevoke, MAX_ACTIVE_DEVICES } from "@/domain/clients/devices";
import { recordAudit } from "./audit";
import { clientDevices, clients } from "./schema";
import { rowsOf } from "./sql";
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

/**
 * Recuerda este navegador para el cliente; devuelve el token que va en la cookie. Deja como máximo
 * MAX_ACTIVE_DEVICES activos: revoca los que llevan más tiempo sin usarse (src/domain/clients/devices.ts).
 * Bloquea la fila del cliente (FOR UPDATE) antes de contar, en su propia transacción o en un
 * savepoint de la del llamador: dos reservas simultáneas del mismo cliente cuentan una después de la
 * otra y el tope se cumple. En la reserva el cliente ya viene bloqueado y el bloqueo no espera.
 */
export async function rememberClientDevice(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<string> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)))
      .for("update");
    return rememberLocked(tx, input);
  });
}

async function rememberLocked(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const [created] = await db
    .insert(clientDevices)
    .values({
      locationId: input.locationId,
      clientId: input.clientId,
      tokenHash: hashToken(token),
      expiresAt: new Date(input.now.getTime() + DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning({ id: clientDevices.id });
  const active = await db
    .select({ id: clientDevices.id, createdAt: clientDevices.createdAt, lastUsedAt: clientDevices.lastUsedAt })
    .from(clientDevices)
    .where(activeDevicesOf(input));
  const revoke = devicesToRevoke(active, created!.id, MAX_ACTIVE_DEVICES);
  if (revoke.length > 0) {
    await db
      .update(clientDevices)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(clientDevices.locationId, input.locationId), inArray(clientDevices.id, revoke), isNull(clientDevices.revokedAt)));
  }
  return token;
}

/** Los navegadores que todavía sirven: sin revocar y sin vencer. */
function activeDevicesOf(input: { locationId: bigint; clientId: bigint; now: Date }) {
  return and(
    eq(clientDevices.locationId, input.locationId),
    eq(clientDevices.clientId, input.clientId),
    isNull(clientDevices.revokedAt),
    gt(clientDevices.expiresAt, input.now),
  );
}

/** Para la ficha: cuántos navegadores recordados activos tiene y cuándo se usó el último. */
export async function clientDeviceSummary(db: Db, input: { locationId: bigint; clientId: bigint; now: Date }): Promise<{ active: number; lastUsedAt: Date | null }> {
  const [row] = await db
    .select({
      active: sql<string>`count(*)`,
      // Recordarlo cuenta como uso: se recordó al reservar.
      lastUsedAt: sql<string | null>`max(coalesce(${clientDevices.lastUsedAt}, ${clientDevices.createdAt}))`,
    })
    .from(clientDevices)
    .where(activeDevicesOf(input));
  return { active: Number(row?.active ?? 0), lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt) : null };
}

/**
 * "Olvidar los navegadores de este cliente" desde la ficha (auditoría del sprint 6, M2): revoca
 * todos los activos y deja el evento en la misma transacción. Revocar es definitivo (trigger 0017).
 * Sin navegadores activos no escribe nada. Devuelve cuántos revocó.
 */
export async function forgetClientDevices(
  db: Db,
  input: { locationId: bigint; clientId: bigint; actor: { userId: string; staffId: bigint }; now: Date },
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [client] = await tx
      .select({ id: clients.id, anonymizedAt: clients.anonymizedAt })
      .from(clients)
      .where(and(eq(clients.locationId, input.locationId), eq(clients.id, input.clientId)))
      .for("update");
    if (!client || client.anonymizedAt) throw new InvalidClientError("El cliente no existe en esta sede");
    const revoked = await tx.update(clientDevices).set({ revokedAt: sql`now()` }).where(activeDevicesOf(input)).returning({ id: clientDevices.id });
    if (revoked.length === 0) throw new InvalidClientError("Este cliente no tiene navegadores recordados");
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "client.devices_forget",
      targetKind: "client",
      targetRef: input.clientId.toString(),
      summary: `Olvidó ${revoked.length === 1 ? "1 navegador recordado" : `${revoked.length} navegadores recordados`} de un cliente`,
    });
    return revoked.length;
  });
}

/**
 * Mantenimiento diario: borra los navegadores revocados o vencidos hace más de DEVICE_PURGE_DAYS
 * días (con el reloj de la base). La base vuelve a exigirlo con un trigger (0025).
 */
export async function purgeClientDevices(db: Db): Promise<number> {
  const rows = rowsOf<{ n: number }>(
    await db.execute(sql`
      with gone as (
        delete from client_devices
         where (revoked_at is not null and revoked_at < now() - make_interval(days => ${DEVICE_PURGE_DAYS}))
            or expires_at < now() - make_interval(days => ${DEVICE_PURGE_DAYS})
        returning 1
      )
      select count(*)::int as n from gone`),
  );
  return Number(rows[0]?.n ?? 0);
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
