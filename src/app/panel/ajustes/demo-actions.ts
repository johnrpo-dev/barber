"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { DemoResetError, demoResetEnabled, resetDemoData } from "@/db/demo-reset";
import type { Db } from "@/db/types";
import { type ActionResult, runAction } from "@/lib/action";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// "Empezar de cero" en la demo (docs/demo.md): solo el dueño, solo con la app en modo demo, escribiendo
// BORRAR y con la identidad confirmada hace poco (contraseña y código). Los demás candados (base
// villa_demo, superusuario, sin respaldos) los revisa src/db/demo-reset.ts dentro de la transacción.

const resetInput = z.object({
  confirmation: z.literal("BORRAR", "Escribe BORRAR para confirmar"),
});

export async function resetDemoDataAction(raw: z.input<typeof resetInput>): Promise<ActionResult<{ tables: number }>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    if (!demoResetEnabled()) throw new DemoResetError("Esta acción solo existe en la demo");
    resetInput.parse(raw);
    requireRecentAuth(staff);
    const result = await resetDemoData(db() as unknown as Db);
    // La bitácora también se vacía: el rastro queda en el registro del servidor.
    console.warn(`[demo] ${staff.displayName} (usuario ${staff.userId}) vació la base de la demo: ${result.tables} tablas`);
    revalidatePath("/panel", "layout");
    return result;
  });
}
