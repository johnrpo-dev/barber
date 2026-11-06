import { InvalidClientError } from "./client";

// Consentimientos de la Ley 1581: tres propósitos separados, casillas sin marcar.
// client_consents es solo-inserción; manda la última fila (mayor id) por cliente y propósito.

export const CONSENT_PURPOSES = ["data_processing", "reminders", "marketing"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export interface ConsentChoices {
  dataProcessing: boolean;
  reminders: boolean;
  marketing: boolean;
}

/** El tratamiento de datos es obligatorio para reservar en línea; lo demás es opcional. */
export function assertBookingConsent(c: ConsentChoices): void {
  if (!c.dataProcessing) throw new InvalidClientError("Para reservar debes autorizar el tratamiento de tus datos");
}

/** Siempre las tres filas: un "no" también es evidencia (y revoca un "sí" anterior). */
export function consentRows(c: ConsentChoices): { purpose: ConsentPurpose; granted: boolean }[] {
  return [
    { purpose: "data_processing", granted: c.dataProcessing },
    { purpose: "reminders", granted: c.reminders },
    { purpose: "marketing", granted: c.marketing },
  ];
}

/**
 * Lo que el personal puede retirar desde la ficha del cliente cuando la persona lo pide (Ley 1581:
 * derecho a revocar). El tratamiento de datos no está: retirarlo es pedir la supresión.
 */
export const WITHDRAWABLE_PURPOSES = ["reminders", "marketing"] as const;
export type WithdrawablePurpose = (typeof WITHDRAWABLE_PURPOSES)[number];

export const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  data_processing: "Tratamiento de datos",
  reminders: "Recordatorio de la cita",
  marketing: "Promociones",
};

/** La última fila de un propósito, tal como la guarda client_consents. */
export interface ConsentRecord {
  granted: boolean;
  textVersion: string;
  source: "online" | "staff";
}

/**
 * El cliente recordado (reserva sin código) autorizó con una política anterior a la vigente: se le
 * pide una vez la autorización nueva. Cuenta el tratamiento de datos y el recordatorio (que desde
 * 2026-11-05b va con él). Un "no" al recordatorio (lo haya marcado la persona en línea o lo haya
 * retirado el personal) se respeta siempre: no obliga a volver a pedir y la renovación no lo
 * deshace (Ley 1581: sin autorización no se envía). Ver renewalRows.
 * Sin tratamiento de datos vigente no aplica: ese cliente vuelve al flujo con código.
 */
export function needsConsentRenewal(
  latest: Partial<Record<ConsentPurpose, ConsentRecord>>,
  currentVersion: string,
): boolean {
  const data = latest.data_processing;
  if (!data?.granted) return false;
  if (data.textVersion !== currentVersion) return true;
  const reminders = latest.reminders;
  if (!reminders) return true;
  return reminders.granted && reminders.textVersion !== currentVersion;
}

/**
 * Las filas de la renovación, con la versión vigente: siempre el tratamiento de datos; el
 * recordatorio solo si no había fila o si la última era un "sí" de una versión anterior (el texto de
 * la casilla incluye el recordatorio del mismo día). Un "no" previo al recordatorio sigue mandando.
 * Las promociones no se tocan.
 */
export function renewalRows(latest: Partial<Record<ConsentPurpose, ConsentRecord>>, currentVersion: string): { purpose: ConsentPurpose; granted: true }[] {
  const rows: { purpose: ConsentPurpose; granted: true }[] = [{ purpose: "data_processing", granted: true }];
  const reminders = latest.reminders;
  if (!reminders || (reminders.granted && reminders.textVersion !== currentVersion)) rows.push({ purpose: "reminders", granted: true });
  return rows;
}

/** Lo vigente para un propósito: la fila de mayor id. Sin filas, no hay consentimiento. */
export function latestConsent(
  rows: readonly { purpose: ConsentPurpose; granted: boolean; id: bigint }[],
  purpose: ConsentPurpose,
): boolean {
  let latest: { granted: boolean; id: bigint } | undefined;
  for (const r of rows) if (r.purpose === purpose && (!latest || r.id > latest.id)) latest = r;
  return latest?.granted ?? false;
}
