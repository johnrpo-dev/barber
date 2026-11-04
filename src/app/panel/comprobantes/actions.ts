"use server";

import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { receiptByPublicId } from "@/db/commissions";
import type { Db } from "@/db/types";
import { isUlid } from "@/db/ulid";
import { receiptNumberLabel } from "@/domain/commissions/settlement";
import { bpsLabel } from "@/domain/reports/rates";
import { can } from "@/domain/staff/roles";
import { type ActionResult, runAction } from "@/lib/action";
import { absLabel, atLabel, moneyLabel, paidFromLabel, signedLabel } from "@/lib/labels";
import { requireStaff } from "@/lib/session";

// Comprobante de una liquidación o de un anticipo (docs/sprint-5-comisiones-informes.md §12.3). El
// dueño ve cualquiera de su sede y el barbero solo los suyos. Un id inválido, inexistente, de otra
// sede o de otra persona da el mismo 404: no se puede saber si un comprobante existe.

export type ReceiptView = {
  kind: "settlement" | "advance";
  publicId: string;
  numberLabel: string;
  status: "settled" | "reversed" | "active";
  locationName: string;
  staffName: string;
  businessDate: string;
  createdAtLabel: string;
  createdBy: string;
  paidFromLabel: string | null;
  period: { fromDate: string | null; cutoffDate: string } | null;
  commissions: { businessDate: string; description: string; netLabel: string; rateLabel: string; commissionLabel: string }[];
  clawbacks: { businessDate: string; description: string; settlementNumberLabel: string; amountLabel: string }[];
  tipsLabel: string | null;
  adjustments: { direction: "add" | "deduct"; amountLabel: string; reason: string }[];
  advanceDeductionLabel: string | null;
  carryOverLabel: string | null;
  totals: { commissionLabel: string; clawbackLabel: string; grossLabel: string; payoutLabel: string } | null;
  advance: { amountLabel: string; reason: string } | null;
  reversal: { atLabel: string; by: string; reason: string } | null;
  note: string | null;
};

const receiptInput = z.object({ publicId: z.string() });

export async function loadReceipt(raw: z.input<typeof receiptInput>): Promise<ActionResult<ReceiptView>> {
  const staff = await requireStaff();
  const seesAll = can(staff.role, "commissions.view.all");
  if (!seesAll && !can(staff.role, "commissions.view.own")) redirect("/panel?sin-permiso=1");
  return runAction(async () => {
    const { publicId } = receiptInput.parse(raw);
    if (!isUlid(publicId)) notFound();
    const r = await receiptByPublicId(db() as unknown as Db, { locationId: staff.locationId, publicId });
    if (!r || (!seesAll && r.staffId !== staff.staffId)) notFound();

    const common = {
      kind: r.kind,
      publicId: r.publicId,
      numberLabel: receiptNumberLabel(r.number),
      status: r.status,
      locationName: r.locationName,
      staffName: r.staffName,
      businessDate: r.businessDate,
      createdAtLabel: atLabel(r.createdAt, r.timeZone),
      createdBy: r.createdBy,
      reversal: r.reversal && { atLabel: atLabel(r.reversal.at, r.timeZone), by: r.reversal.by, reason: r.reversal.reason },
    };
    if (r.kind === "advance") {
      return {
        ...common,
        paidFromLabel: paidFromLabel(r.paidFrom),
        period: null,
        commissions: [],
        clawbacks: [],
        tipsLabel: null,
        adjustments: [],
        advanceDeductionLabel: null,
        carryOverLabel: null,
        totals: null,
        advance: { amountLabel: moneyLabel(r.amount), reason: r.reason },
        note: null,
      };
    }
    return {
      ...common,
      paidFromLabel: r.paidFrom ? paidFromLabel(r.paidFrom) : null,
      period: { fromDate: r.periodFrom, cutoffDate: r.cutoffDate },
      commissions: r.commissions.map((c) => ({
        businessDate: c.businessDate,
        description: c.description,
        netLabel: moneyLabel(c.net),
        rateLabel: bpsLabel(BigInt(c.commissionBps)),
        commissionLabel: moneyLabel(c.commission),
      })),
      clawbacks: r.clawbacks.map((c) => ({
        businessDate: c.businessDate,
        description: c.description,
        settlementNumberLabel: c.settlementNumber === null ? "" : receiptNumberLabel(c.settlementNumber),
        amountLabel: absLabel(c.amount),
      })),
      tipsLabel: r.tips === 0n ? null : signedLabel(r.tips),
      adjustments: r.adjustments.map((a) => ({
        direction: a.amount >= 0n ? ("add" as const) : ("deduct" as const),
        amountLabel: absLabel(a.amount),
        reason: a.reason,
      })),
      advanceDeductionLabel: r.advanceDeduction === 0n ? null : absLabel(r.advanceDeduction),
      carryOverLabel: r.carryOver === 0n ? null : absLabel(r.carryOver),
      totals: {
        commissionLabel: absLabel(r.commissionTotal),
        clawbackLabel: absLabel(r.clawbackTotal),
        grossLabel: moneyLabel(r.commissionTotal - r.clawbackTotal + r.tips + r.adjustmentsTotal),
        payoutLabel: absLabel(r.payout),
      },
      advance: null,
      note: r.note,
    };
  });
}
