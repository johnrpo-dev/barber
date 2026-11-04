import { createHash } from "node:crypto";

// Retención de datos personales (Ley 1581, principio de finalidad y temporalidad). Los mismos
// días viven en la base (funciones villa_pii_retention y villa_read_audit_retention de la
// migración 0012), que es la que hace cumplir la purga; src/db/privacy.test.ts compara ambos, y
// la política de privacidad publicada (src/content/privacy) los cita.
//
// - Restos de la reserva en línea (IP, navegador, nombre y correo escritos al pedir el código, y
//   el contenido de los mensajes enviados): 30 días. El código vive minutos; 30 días alcanzan para
//   revisar un abuso de la reserva o una queja por un mensaje. La prueba de la autorización vive en
//   client_consents y se conserva mientras se traten los datos.
// - Registro de quién vio el celular de un cliente: 365 días. Es la ventana en la que una persona
//   suele reclamar por un uso indebido de su número; más allá sería guardar datos sin finalidad.

export const PII_RETENTION_DAYS = 30;
/**
 * Cuánto vive la copia más vieja de un backup. La cumplen las reglas de ciclo de vida del bucket
 * (docs/despliegue.md, "Bucket"): monthly/ se borra a los 366 días.
 */
export const BACKUP_RETENTION_MONTHS = 12;
export const READ_AUDIT_RETENTION_DAYS = 365;

/** Recargar la misma pantalla dentro de esta ventana no deja otra fila en la auditoría. */
export const READ_AUDIT_WINDOW_MS = 10 * 60_000;

/** Pantallas que muestran el celular completo de un cliente. */
export type ContactReadContext = "agenda_day" | "client_search";

/** Hasta cuántos clientes se registran en una fila (el CHECK de la tabla). */
export const MAX_CLIENTS_PER_READ = 500;

/**
 * Lo que se guarda de una lectura: los clientes sin repetir y en orden, y su SHA-256 (con él la
 * base descarta la misma lectura dentro de la ventana). Sin clientes no hay nada que auditar.
 */
export function contactReadKey(clientIds: readonly bigint[]): { clientIds: bigint[]; clientsHash: string } | null {
  const unique = [...new Set(clientIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_CLIENTS_PER_READ);
  if (unique.length === 0) return null;
  const clientsHash = createHash("sha256").update(`villa:contact-read:${unique.join(",")}`).digest("hex");
  return { clientIds: unique, clientsHash };
}

/** Inicio de la ventana de deduplicación que contiene `now`. */
export function readWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / READ_AUDIT_WINDOW_MS) * READ_AUDIT_WINDOW_MS);
}
