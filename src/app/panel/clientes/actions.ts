"use server";

import { z } from "zod";
import { clientErasePreview, eraseClient, searchClients } from "@/db/clients";
import { db } from "@/db/client";
import { recordContactReads } from "@/db/privacy";
import type { Db } from "@/db/types";
import { formatPhone, InvalidClientError } from "@/domain/clients/client";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Supresión de datos de un cliente a su solicitud, tal como promete la política de privacidad
// (docs/sprint-5-comisiones-informes.md §12.8). Solo el dueño, con reautenticación.

const conn = () => db() as unknown as Db;

export type ClientOption = { id: string; name: string; phone: string | null };

export type ClientErasePreviewView = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  appointments: number;
  activeAppointments: number;
  sales: number;
};

export async function loadClientsToErase(query: string): Promise<ActionResult<ClientOption[]>> {
  const staff = await requirePermission("clients.erase");
  return runAction(async () => {
    const q = z.string().max(80).parse(query);
    const rows = await searchClients(conn(), { locationId: staff.locationId, query: q });
    // Ley 1581: queda constancia de quién vio el celular completo (src/db/privacy.ts).
    await recordContactReads(conn(), { locationId: staff.locationId, staffId: staff.staffId, context: "client_search", clientIds: rows.filter((c) => c.phoneE164).map((c) => c.id) });
    return rows.map((c) => ({ id: c.id.toString(), name: c.name, phone: c.phoneE164 ? formatPhone(c.phoneE164) : null }));
  });
}

const previewInput = z.object({ clientId: idSchema });

export async function loadClientErasePreview(raw: z.input<typeof previewInput>): Promise<ActionResult<ClientErasePreviewView>> {
  const staff = await requirePermission("clients.erase");
  return runAction(async () => {
    const { clientId } = previewInput.parse(raw);
    const preview = await clientErasePreview(conn(), { locationId: staff.locationId, clientId });
    if (!preview) throw new InvalidClientError("El cliente no existe o sus datos ya se suprimieron");
    return {
      id: preview.id.toString(),
      name: preview.name,
      phone: preview.phoneE164 ? formatPhone(preview.phoneE164) : null,
      email: preview.email,
      appointments: preview.appointments,
      activeAppointments: preview.activeAppointments,
      sales: preview.sales,
    };
  });
}

const eraseInput = z.object({
  clientId: idSchema,
  confirmation: z.literal("SUPRIMIR", "Escribe SUPRIMIR para confirmar"),
});

/** No se puede deshacer. El evento de la bitácora no lleva datos de la persona. */
export async function eraseClientAction(raw: z.input<typeof eraseInput>): Promise<ActionResult> {
  const staff = await requirePermission("clients.erase");
  return runAction(async () => {
    const input = eraseInput.parse(raw);
    requireRecentAuth(staff);
    await eraseClient(conn(), { locationId: staff.locationId, clientId: input.clientId, actor: { userId: staff.userId, staffId: staff.staffId } });
    return undefined;
  });
}
