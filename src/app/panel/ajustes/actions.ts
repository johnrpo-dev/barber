"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { setStaffBookableOnline, updateLocationSettings } from "@/db/locations";
import type { Db } from "@/db/types";
import { InvalidClientError, normalizePhone } from "@/domain/clients/client";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission } from "@/lib/session";

// Ajustes de la sede (solo el dueño). La sede sale SIEMPRE de la sesión, nunca del cliente.

const conn = () => db() as unknown as Db;

const minutes = (min: number, max: number, label: string) =>
  z.number().int(`${label}: escribe un número entero`).min(min, `${label}: mínimo ${min}`).max(max, `${label}: máximo ${max}`);

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} es muy largo`)
    .transform((v) => v || null);

const settingsSchema = z.object({
  publicBookingEnabled: z.boolean(),
  publicPhone: optionalText(30, "El teléfono"),
  address: optionalText(200, "La dirección"),
  mapsUrl: optionalText(500, "El enlace del mapa").refine(
    (v) => v === null || /^https:\/\/\S+$/.test(v),
    "El enlace del mapa debe empezar por https://",
  ),
  slotStepMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)], "Elige cada cuánto se ofrecen turnos"),
  minAdvanceMin: minutes(0, 1440, "La anticipación mínima"),
  maxAdvanceDays: minutes(1, 60, "Los días hacia adelante"),
  holdMin: minutes(10, 30, "El tiempo para confirmar"),
  freeCancelHours: minutes(0, 72, "Las horas para cancelar sin penalidad"),
  noShowGraceMin: minutes(0, 60, "La tolerancia de llegada"),
  maxActivePerClient: minutes(1, 10, "Las citas activas por cliente"),
});

export async function updateBookingSettingsAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("settings.manage");
    const input = settingsSchema.parse(raw);
    let publicPhone: string | null = null;
    if (input.publicPhone) {
      // Celular en E.164 (sirve para el enlace de WhatsApp); un fijo se guarda como se escribió.
      publicPhone = normalizePhone(input.publicPhone) ?? (/^\+?[\d\s()-]{7,20}$/.test(input.publicPhone) ? input.publicPhone : null);
      if (!publicPhone) throw new InvalidClientError("El teléfono público no parece un número válido");
    }
    if (input.publicBookingEnabled && !publicPhone && !input.address) {
      throw new InvalidClientError("Para abrir la reserva en línea, escribe al menos el teléfono o la dirección de la sede");
    }
    await updateLocationSettings(conn(), staff.locationId, { ...input, publicPhone });
    revalidatePath("/panel/ajustes");
    revalidatePath("/", "layout");
    return undefined;
  });
}

const bookableSchema = z.object({ staffId: idSchema, bookable: z.boolean() });

export async function setStaffBookableAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("settings.manage");
    const input = bookableSchema.parse(raw);
    await setStaffBookableOnline(conn(), { locationId: staff.locationId, staffId: input.staffId, bookable: input.bookable });
    revalidatePath("/panel/ajustes");
    return undefined;
  });
}
