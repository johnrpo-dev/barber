"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { createService, serviceOf, setServiceActive, updateService } from "@/db/catalog";
import type { Db } from "@/db/types";
import { InvalidServiceError, percentToBps, type ServiceDraft } from "@/domain/catalog/service";
import { fromUnits } from "@/domain/money";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Catálogo de servicios. La sede sale SIEMPRE de la sesión, nunca del cliente.
// El precio viaja como texto de pesos enteros ("35000") y se convierte con fromUnits: nunca pasa por number.
// Precio y comisión son dinero: crear un servicio o cambiarlos exige reautenticación reciente.

const draftSchema = z.object({
  name: z.string().max(80, "El nombre debe tener entre 2 y 80 caracteres"),
  /** Pesos enteros, solo dígitos. */
  priceUnits: z.string().regex(/^\d{1,10}$/, "Escribe el precio en pesos, sin centavos"),
  durationMin: z.number().int("La duración debe ser un número entero de minutos"),
  bufferMin: z.number().int("La limpieza debe ser un número entero de minutos"),
  /** Porcentaje como lo escribe el dueño: "40" o "37,5". */
  commission: z.string().max(8),
  active: z.boolean(),
});

const updateSchema = draftSchema.extend({ serviceId: idSchema });
const activeSchema = z.object({ serviceId: idSchema, active: z.boolean() });

function toDraft(input: z.infer<typeof draftSchema>): ServiceDraft {
  return {
    name: input.name,
    price: fromUnits(BigInt(input.priceUnits)),
    durationMin: input.durationMin,
    bufferMin: input.bufferMin,
    commissionBps: percentToBps(input.commission),
  };
}

/** El índice único por nombre (sin mayúsculas) se traduce a un mensaje para el dueño. */
function duplicateName(err: unknown): never {
  for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
    if (e.message.includes("services_location_name_key")) {
      throw new InvalidServiceError("Ya existe un servicio con ese nombre");
    }
  }
  throw err;
}

export async function createServiceAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("services.manage");
    const input = draftSchema.parse(raw);
    const draft = toDraft(input);
    requireRecentAuth(staff);
    const conn = db() as unknown as Db;
    await conn
      .transaction(async (tx) => {
        const t = tx as unknown as Db;
        const created = await createService(t, { locationId: staff.locationId, draft });
        if (!input.active) await setServiceActive(t, { locationId: staff.locationId, serviceId: created.id, active: false });
      })
      .catch(duplicateName);
    revalidatePath("/panel/servicios");
    return undefined;
  });
}

export async function updateServiceAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("services.manage");
    const input = updateSchema.parse(raw);
    const draft = toDraft(input);
    const conn = db() as unknown as Db;
    await conn
      .transaction(async (tx) => {
        const t = tx as unknown as Db;
        // Se compara dentro de la transacción, con la fila bloqueada: nadie cambia el precio entre medio.
        const current = await serviceOf(t, { locationId: staff.locationId, serviceId: input.serviceId, forUpdate: true });
        if (!current) throw new InvalidServiceError("El servicio no existe en esta sede");
        if (current.price.minor !== draft.price.minor || current.commissionBps !== draft.commissionBps) requireRecentAuth(staff);
        await updateService(t, { locationId: staff.locationId, serviceId: input.serviceId, draft });
        await setServiceActive(t, { locationId: staff.locationId, serviceId: input.serviceId, active: input.active });
      })
      .catch(duplicateName);
    revalidatePath("/panel/servicios");
    return undefined;
  });
}

export async function setServiceActiveAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("services.manage");
    const input = activeSchema.parse(raw);
    await setServiceActive(db() as unknown as Db, {
      locationId: staff.locationId,
      serviceId: input.serviceId,
      active: input.active,
    });
    revalidatePath("/panel/servicios");
    return undefined;
  });
}
