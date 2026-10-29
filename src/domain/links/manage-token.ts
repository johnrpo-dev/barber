import { createHash, createHmac } from "node:crypto";

// Enlace de gestión /cita/[token]. El token se DERIVA (no se sortea) para que el worker pueda
// recalcularlo en cada recordatorio sin guardarlo de forma reversible: la base solo guarda
// SHA-256(token) para buscarlo. Rotar el enlace = subir `generation`.

export const MANAGE_LINK_GRACE_DAYS = 7;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** base64url(HMAC-SHA256(secret, "manage:" + publicId + ":" + generation)): 43 caracteres, sin relleno. */
export function deriveManageToken(secret: string, publicId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new RangeError("La generación debe ser un entero no negativo");
  return createHmac("sha256", secret).update(`manage:${publicId}:${generation}`).digest("base64url");
}

/** Lo que se guarda y se busca en appointment_links (32 bytes). */
export function hashManageToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Filtro barato antes de tocar la base: lo que no tiene forma de token da el mismo 404. */
export function isManageTokenShape(s: string): boolean {
  return TOKEN_SHAPE.test(s);
}

/** El enlace sirve hasta 7 días después de que termina la cita. */
export function manageLinkExpiry(appointmentEnd: Date): Date {
  return new Date(appointmentEnd.getTime() + MANAGE_LINK_GRACE_DAYS * 24 * 3_600_000);
}
