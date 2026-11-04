"use server";

import { z } from "zod";
import { auditLog } from "@/db/audit";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import type { Db } from "@/db/types";
import {
  AUDIT_BPS_FIELDS,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  AUDIT_FIELD_LABELS,
  AUDIT_LABELS,
  AUDIT_MONEY_FIELDS,
  type AuditValue,
} from "@/domain/audit/events";
import { bpsLabel } from "@/domain/reports/rates";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { dateSchema } from "@/lib/action-schemas";
import { atLabel, moneyLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";

// Bitácora de auditoría (docs/sprint-5-comisiones-informes.md §8): de solo lectura y solo para quien
// tiene audit.view. Los valores de `changes` ya salen formateados.

const PAGE_SIZE = 50;

export type AuditLogView = {
  events: {
    id: string;
    atLabel: string;
    actorName: string;
    categoryLabel: string;
    actionLabel: string;
    summary: string;
    changes: { field: string; before: string; after: string }[];
  }[];
  nextCursor: string | null;
};

const logInput = z.object({
  before: idSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
});

function formatValue(field: string, value: AuditValue): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (AUDIT_MONEY_FIELDS.has(field)) return moneyLabel(BigInt(value));
  if (AUDIT_BPS_FIELDS.has(field)) return bpsLabel(BigInt(value));
  return value;
}

export async function loadAuditLog(raw: z.input<typeof logInput>): Promise<ActionResult<AuditLogView>> {
  const staff = await requirePermission("audit.view");
  return runAction(async () => {
    const input = logInput.parse(raw);
    const conn = db() as unknown as Db;
    const { timeZone, businessDate } = await today(conn, staff.locationId);
    const rows = await auditLog(conn, { locationId: staff.locationId, ...input, limit: PAGE_SIZE + 1 });
    const page = rows.slice(0, PAGE_SIZE);
    return {
      events: page.map((e) => ({
        id: e.id.toString(),
        atLabel: atLabel(e.occurredAt, timeZone, businessDate),
        actorName: e.actorName ?? "Sistema",
        categoryLabel: AUDIT_CATEGORY_LABELS[e.category],
        actionLabel: AUDIT_LABELS[e.action],
        summary: e.summary,
        changes: e.changes.map((c) => ({
          field: AUDIT_FIELD_LABELS[c.field] ?? c.field,
          before: formatValue(c.field, c.before),
          after: formatValue(c.field, c.after),
        })),
      })),
      nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1]!.id.toString() : null,
    };
  });
}
