// Datos mínimos del cliente: nombre y celular. Lo justo para agendar y avisar (Ley 1581:
// minimización). Los teléfonos se guardan en E.164 para no duplicar clientes por formato.

export class InvalidClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClientError";
  }
}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * "300 123 4567", "(300) 123-4567", "57 3001234567" o "+57 300…" → "+573001234567".
 * Sin prefijo se asume Colombia. Devuelve null si no parece un número válido.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");
  let e164: string;
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10 && digits.startsWith("3")) e164 = `+57${digits}`; // celular colombiano
  else if (digits.length === 12 && digits.startsWith("57")) e164 = `+${digits}`;
  else return null;
  if (!E164.test(e164)) return null;
  // Celulares de Colombia: +57 3xx xxx xxxx.
  if (e164.startsWith("+57") && !/^\+573\d{9}$/.test(e164)) return null;
  return e164;
}

/** "+573001234567" → "300 123 4567" para mostrar a quien puede ver contactos. */
export function formatPhone(e164: string): string {
  const co = /^\+57(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return co ? `${co[1]} ${co[2]} ${co[3]}` : e164;
}

/** "+573001234567" → "300 ••• ••67" para quien no tiene permiso de ver contactos. */
export function maskPhone(e164: string): string {
  const co = /^\+57(\d{3})\d{5}(\d{2})$/.exec(e164);
  return co ? `${co[1]} ••• ••${co[2]}` : `••••${e164.slice(-2)}`;
}

export function assertValidClientName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 80) throw new InvalidClientError("El nombre debe tener entre 2 y 80 caracteres");
  return clean;
}
