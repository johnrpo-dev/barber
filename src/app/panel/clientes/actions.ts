"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { forgetClientDevices } from "@/db/client-devices";
import { CLIENT_HISTORY_LIMIT, clientRecord } from "@/db/client-record";
import { CLIENT_SEARCH_LIMIT, clientErasePreview, eraseClient, searchClients } from "@/db/clients";
import { db } from "@/db/client";
import { withdrawConsent } from "@/db/consents";
import { clearNoShows } from "@/db/no-shows";
import { recordContactReads } from "@/db/privacy";
import { locations } from "@/db/schema";
import type { Db } from "@/db/types";
import { formatPhone, InvalidClientError } from "@/domain/clients/client";
import { WITHDRAWABLE_PURPOSES } from "@/domain/clients/consent";
import { can } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission, requireRecentAuth } from "@/lib/session";
import { type ClientRecordView, toClientRecordView } from "./record-view";

import { textSchema } from "@/lib/action-schemas";
// Clientes en el panel:
// - Supresión de datos a su solicitud, tal como promete la política de privacidad
//   (docs/sprint-5-comisiones-informes.md §12.8). Solo el dueño, con reautenticación, desde la ficha.
// - Ficha del cliente (sprint 7, clients.manage: dueño y recepción): historial, faltas,
//   autorizaciones y navegadores recordados; retirar el recordatorio o las promociones, olvidar
//   los navegadores y desbloquear la reserva en línea. La sede sale siempre de la sesión.

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

// ─── Ficha del cliente (sprint 7) ────────────────────────────────────────────

export type ClientSearchView = { clients: ClientOption[]; hasMore: boolean };

/**
 * Buscar para abrir la ficha: hasta CLIENT_SEARCH_LIMIT resultados y si hay más (para pedir que
 * afinen la búsqueda). Ley 1581: deja constancia de quién vio el celular completo de los que se
 * muestran (src/db/privacy.ts).
 */
export async function loadClientSearch(query: string): Promise<ActionResult<ClientSearchView>> {
  const staff = await requirePermission("clients.manage");
  return runAction(async () => {
    const q = textSchema().max(80).parse(query);
    const found = await searchClients(conn(), { locationId: staff.locationId, query: q, limit: CLIENT_SEARCH_LIMIT + 1 });
    const rows = found.slice(0, CLIENT_SEARCH_LIMIT);
    await recordContactReads(conn(), { locationId: staff.locationId, staffId: staff.staffId, context: "client_search", clientIds: rows.filter((c) => c.phoneE164).map((c) => c.id) });
    return {
      clients: rows.map((c) => ({ id: c.id.toString(), name: c.name, phone: c.phoneE164 ? formatPhone(c.phoneE164) : null })),
      hasMore: found.length > CLIENT_SEARCH_LIMIT,
    };
  });
}

const clientInput = z.object({ clientId: idSchema });

export async function loadClientRecord(raw: z.input<typeof clientInput>): Promise<ActionResult<ClientRecordView>> {
  const staff = await requirePermission("clients.manage");
  return runAction(async () => {
    const { clientId } = clientInput.parse(raw);
    const now = new Date();
    const record = await clientRecord(conn(), { locationId: staff.locationId, clientId, now });
    if (!record) throw new InvalidClientError("El cliente no existe o sus datos ya se suprimieron");
    const canViewContact = can(staff.role, "clients.view.contact");
    if (canViewContact && record.phoneE164) {
      await recordContactReads(conn(), { locationId: staff.locationId, staffId: staff.staffId, context: "client_search", clientIds: [record.id], now });
    }
    const [loc] = await conn().select({ timeZone: locations.timezone }).from(locations).where(eq(locations.id, staff.locationId));
    return toClientRecordView(record, { timeZone: loc?.timeZone ?? "America/Bogota", historyLimit: CLIENT_HISTORY_LIMIT, canViewContact });
  });
}

const withdrawInput = z.object({ clientId: idSchema, purpose: z.enum(WITHDRAWABLE_PURPOSES) });

/** Retira el recordatorio o las promociones a pedido del cliente: una fila nueva y su evento. */
export async function withdrawConsentAction(raw: z.input<typeof withdrawInput>): Promise<ActionResult> {
  const staff = await requirePermission("clients.manage");
  return runAction(async () => {
    const input = withdrawInput.parse(raw);
    await withdrawConsent(conn(), { locationId: staff.locationId, clientId: input.clientId, purpose: input.purpose, actor: { userId: staff.userId, staffId: staff.staffId } });
    return undefined;
  });
}

/** "Olvidar los navegadores de este cliente": revoca todos los recordados, con su evento. */
export async function forgetClientDevicesAction(raw: z.input<typeof clientInput>): Promise<ActionResult<{ forgotten: number }>> {
  const staff = await requirePermission("clients.manage");
  return runAction(async () => {
    const { clientId } = clientInput.parse(raw);
    const forgotten = await forgetClientDevices(conn(), { locationId: staff.locationId, clientId, actor: { userId: staff.userId, staffId: staff.staffId }, now: new Date() });
    return { forgotten };
  });
}

/** Desbloquea la reserva en línea desde la ficha: la misma regla que el botón de la agenda (src/db/no-shows.ts). */
export async function clearClientNoShowsAction(raw: z.input<typeof clientInput>): Promise<ActionResult> {
  const staff = await requirePermission("clients.manage");
  return runAction(async () => {
    const { clientId } = clientInput.parse(raw);
    await clearNoShows(conn(), { locationId: staff.locationId, clientId, actor: { userId: staff.userId, staffId: staff.staffId }, now: new Date() });
    return undefined;
  });
}
