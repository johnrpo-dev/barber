import { randomBytes } from "node:crypto";

// ULID (https://github.com/ulid/spec): 48 bits de tiempo + 80 bits aleatorios en base32 de Crockford.
// Es lo único que identifica una cita hacia afuera; los IDs internos no salen de la base.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
