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

/** Lo vigente para un propósito: la fila de mayor id. Sin filas, no hay consentimiento. */
export function latestConsent(
  rows: readonly { purpose: ConsentPurpose; granted: boolean; id: bigint }[],
  purpose: ConsentPurpose,
): boolean {
  let latest: { granted: boolean; id: bigint } | undefined;
  for (const r of rows) if (r.purpose === purpose && (!latest || r.id > latest.id)) latest = r;
  return latest?.granted ?? false;
}
