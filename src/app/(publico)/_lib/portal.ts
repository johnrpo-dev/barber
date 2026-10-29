import { cache } from "react";
import { describeError } from "@/lib/log";
import { loadPortal, type PortalView } from "../data";

// Una sola lectura de la sede por petición: el layout (cabecera y pie) y la página la comparten.
// Si la base falla, el portal se degrada a "llámanos" en vez de caerse; el error queda registrado.
export const getPortal = cache(async (): Promise<PortalView | null> => {
  try {
    return await loadPortal();
  } catch (err) {
    console.error("[portal]", describeError(err));
    return null;
  }
});

/** Enlace tel: a partir del número público ("+57 300 123 4567" → "tel:+573001234567"). */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const clean = phone.replace(/[^\d+]/g, "");
  return clean ? `tel:${clean}` : null;
}
