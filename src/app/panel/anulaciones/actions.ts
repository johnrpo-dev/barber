"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import type { Db } from "@/db/types";
import { decideVoid, voidQueue } from "@/db/voids";
import { can } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { idempotencyKeySchema } from "@/lib/action-schemas";
import { atLabel, moneyLabel } from "@/lib/labels";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Anulaciones (docs/sprint-4-cobro-caja.md §6 y §9). El dueño (ledger.reverse) ve la cola completa
// y decide con reautenticación; quien solo cobra (ledger.post) ve sus propias solicitudes.

const database = () => db() as unknown as Db;

export interface VoidQueueView {
  requests: {
    id: string;
    saleId: string;
    atLabel: string;
    requestedBy: string;
    chargedBy: string;
    reason: string;
    totalLabel: string;
    lines: string[];
    status: "pending" | "approved" | "rejected";
  }[];
}

export async function loadVoidQueue(): Promise<ActionResult<VoidQueueView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const conn = database();
    const day = await today(conn, staff.locationId);
    const rows = await voidQueue(conn, {
      locationId: staff.locationId,
      requestedBy: can(staff.role, "ledger.reverse") ? undefined : staff.userId,
    });
    return {
      requests: rows.map((r) => ({
        id: r.id.toString(),
        saleId: r.saleId.toString(),
        atLabel: atLabel(r.createdAt, day.timeZone, day.businessDate),
        requestedBy: r.requestedBy ?? "Personal",
        chargedBy: r.chargedBy ?? "Personal",
        reason: r.reason,
        totalLabel: moneyLabel(r.totalPaid),
        lines: r.lines.map((l) => `${l.description} · ${moneyLabel(l.net)}`),
        status: r.status,
      })),
    };
  });
}

const decideInput = z.object({
  requestId: idSchema,
  approve: z.boolean(),
  note: z.string().max(300, "La nota es muy larga"),
  idempotencyKey: idempotencyKeySchema,
});

export async function decideVoidAction(
  raw: z.input<typeof decideInput>,
): Promise<ActionResult<{ status: "approved" | "rejected"; warning: string | null }>> {
  const staff = await requirePermission("ledger.reverse");
  return runAction(async () => {
    // Aprobar o rechazar una anulación es crítico: exige haber confirmado identidad hace poco.
    requireRecentAuth(staff);
    const input = decideInput.parse(raw);
    const decision = await decideVoid(database(), {
      locationId: staff.locationId,
      requestId: input.requestId,
      approve: input.approve,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      approver: { userId: staff.userId, role: staff.role },
    });
    revalidatePath("/panel/anulaciones");
    revalidatePath("/panel/caja");
    return { status: decision.status, warning: decision.warning };
  });
}
