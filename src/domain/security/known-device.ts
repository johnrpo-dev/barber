import { createHmac, timingSafeEqual } from "node:crypto";

// "Dispositivo conocido": cookie firmada (HMAC con BETTER_AUTH_SECRET) que se pone tras un ingreso
// completo (contraseña y, si aplica, código). Exime a ese navegador del límite GLOBAL por correo,
// nunca del bloqueo duro por (correo, IP). Así un atacante que reparte intentos desde muchas IP
// no deja al dueño fuera desde su propio celular.
//
// Valor: hasta MAX_ENTRIES entradas "vence.firma" separadas por "~" (un navegador compartido, como
// el de recepción, puede ser conocido para varias personas). La firma liga la entrada al correo
// sin guardarlo: HMAC(secreto, correo + vencimiento), recortado a 128 bits.

export const KNOWN_DEVICE_COOKIE = "known_device";
export const KNOWN_DEVICE_MAX_AGE_S = 90 * 86_400;
export const MAX_ENTRIES = 5;

const normalize = (email: string) => email.trim().toLowerCase();

function sign(secret: string, email: string, expiresAtS: number): string {
  return createHmac("sha256", secret).update(`villa:known-device:${normalize(email)}:${expiresAtS}`).digest("base64url").slice(0, 22);
}

function parse(value: string | null | undefined): { exp: number; mac: string }[] {
  if (!value || value.length > 400) return [];
  return value
    .split("~")
    .map((entry) => /^(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(entry))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ exp: Number(m[1]), mac: m[2]! }))
    .slice(0, MAX_ENTRIES);
}

function matches(secret: string, email: string, entry: { exp: number; mac: string }): boolean {
  const expected = Buffer.from(sign(secret, email, entry.exp));
  const given = Buffer.from(entry.mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** ¿Este navegador ya ingresó (completo) con este correo y la marca sigue vigente? */
export function isKnownDevice(secret: string, cookieValue: string | null | undefined, email: string, now: Date): boolean {
  if (!email.trim()) return false;
  const nowS = Math.floor(now.getTime() / 1000);
  return parse(cookieValue).some((e) => e.exp > nowS && matches(secret, email, e));
}

/** Nuevo valor de la cookie con este correo marcado (renovado) y sin entradas vencidas. */
export function withKnownDevice(secret: string, cookieValue: string | null | undefined, email: string, now: Date): string {
  const nowS = Math.floor(now.getTime() / 1000);
  const exp = nowS + KNOWN_DEVICE_MAX_AGE_S;
  const others = parse(cookieValue).filter((e) => e.exp > nowS && !matches(secret, email, e));
  return [{ exp, mac: sign(secret, email, exp) }, ...others]
    .slice(0, MAX_ENTRIES)
    .map((e) => `${e.exp}.${e.mac}`)
    .join("~");
}
