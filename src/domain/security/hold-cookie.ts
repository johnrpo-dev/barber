import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Cookie "villa_hold" de la reserva en línea: liga el código de verificación al navegador que lo
// pidió (la base guarda el SHA-256 del identificador). Auditoría del sprint 3: alguien que pudiera
// plantar la cookie (desde un subdominio, por ejemplo) fijaría el identificador de otra persona.
//
// Dos defensas (sprint 5):
// 1. Va firmada: "identificador.firma", con HMAC-SHA256 y una llave derivada del secreto de lo
//    público (OTP_PEPPER). Un valor inventado o alterado no se acepta.
// 2. Al iniciar una reserva, la cookie que trae el navegador solo se reutiliza si tiene una
//    verificación viva; si no, se emite una nueva. Así ni un valor firmado y plantado (sacado de
//    otro navegador) se vuelve el de una reserva nueva.
//
// La llave sale de OTP_PEPPER y no de BETTER_AUTH_SECRET: lo público no depende del secreto del
// personal (que no se rota a la ligera), y OTP_PEPPER ya es obligatorio para reservar en línea.

export const HOLD_COOKIE = "villa_hold";

const ID_BYTES = 32;
const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const SIG_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function holdKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("villa:hold-cookie:key").digest();
}

function signature(secret: string, id: string): string {
  return createHmac("sha256", holdKey(secret)).update(`villa:hold:${id}`).digest("base64url");
}

/** Identificador nuevo (256 bits) para un navegador. */
export function newHoldId(): string {
  return randomBytes(ID_BYTES).toString("base64url");
}

/** Valor de la cookie: "identificador.firma". */
export function signHoldId(secret: string, id: string): string {
  if (!ID_SHAPE.test(id)) throw new Error("Identificador de retención inválido");
  return `${id}.${signature(secret, id)}`;
}

/** El identificador si la cookie está bien firmada; si no (inventada, alterada, vieja), null. */
export function readHoldCookie(secret: string, value: string | undefined | null): string | null {
  if (!value || value.length > 100) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!ID_SHAPE.test(id) || !SIG_SHAPE.test(sig)) return null;
  const expected = Buffer.from(signature(secret, id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}
