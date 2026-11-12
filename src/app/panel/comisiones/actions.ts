"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addDays } from "@/domain/booking/clock";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import {
  commissionBalances,
  commissionBalanceTotals,
  giveAdvance,
  previewSettlement,
  reverseAdvance,
  reverseSettlement,
  settleCommissions,
  type SettlementOptions,
  staffCommissionDetail,
} from "@/db/commissions";
import { readOnlySnapshot } from "@/db/reports";
import type { Db } from "@/db/types";
import { isUlid } from "@/db/ulid";
import { estimatedPayout, receiptNumberLabel, SettlementError, settledTips } from "@/domain/commissions/settlement";
import { money } from "@/domain/money";
import { bpsLabel } from "@/domain/reports/rates";
import { can } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { dateSchema, idempotencyKeySchema, textSchema, unitsSchema } from "@/lib/action-schemas";
import { absLabel, minorText, moneyLabel, paidFromLabel, signedLabel } from "@/lib/labels";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Comisiones del personal (docs/sprint-5-comisiones-informes.md §10 y §12.3). Todo sale de la base y
// viaja como texto de centavos más su etiqueta; la sede y la persona que actúa salen de la sesión.

const conn = () => db() as unknown as Db;

function refresh() {
  revalidatePath("/panel/comisiones", "layout");
  revalidatePath("/panel/inicio");
  revalidatePath("/panel/caja");
  revalidatePath("/panel/mis-comisiones");
}

const reasonSchema = (what: string) =>
  textSchema().min(3, `Escribe ${what} (mínimo 3 caracteres)`).max(300, `${what[0]!.toUpperCase()}${what.slice(1)} es muy largo`);
const publicIdSchema = z.string().refine(isUlid, "Comprobante inválido");
const paidFromSchema = z.enum(["cash", "bank"]);

export type CommissionsOverview = {
  businessDate: string;
  staff: {
    staffId: string;
    name: string;
    active: boolean;
    pendingCommissionMinor: string;
    pendingCommissionLabel: string;
    pendingLines: number;
    clawbacksMinor: string;
    clawbacksLabel: string;
    tipsOwedMinor: string;
    tipsOwedLabel: string;
    receivableMinor: string;
    receivableLabel: string;
    estimatedPayoutMinor: string;
    estimatedPayoutLabel: string;
    lastSettlement: { publicId: string; numberLabel: string; cutoffDate: string; payoutLabel: string } | null;
  }[];
  totals: { commissionOwedLabel: string; tipsOwedLabel: string; receivableLabel: string };
  canSettle: boolean;
};

export async function loadCommissionsOverview(): Promise<ActionResult<CommissionsOverview>> {
  const staff = await requirePermission("commissions.view.all");
  return runAction(async () =>
    readOnlySnapshot(conn(), async (tx) => {
      const [day, balances, totals] = [
        await today(tx, staff.locationId),
        await commissionBalances(tx, staff.locationId),
        await commissionBalanceTotals(tx, staff.locationId),
      ];
      return {
        businessDate: day.businessDate,
        // Quien ya no está solo aparece si queda algo por arreglar con esa persona.
        staff: balances
          .filter((b) => b.active || b.commissionOwed !== 0n || b.tipsOwed !== 0n || b.receivable !== 0n)
          .map((b) => {
            const estimated = estimatedPayout({
              commission: money(b.pendingCommission),
              clawbacks: money(b.clawbacks),
              tipsOwed: money(b.tipsOwed),
              receivable: money(b.receivable),
            }).minor;
            return {
              staffId: b.staffId.toString(),
              name: b.name,
              active: b.active,
              pendingCommissionMinor: minorText(b.pendingCommission),
              pendingCommissionLabel: moneyLabel(b.pendingCommission),
              pendingLines: b.pendingLines,
              clawbacksMinor: minorText(b.clawbacks),
              clawbacksLabel: absLabel(b.clawbacks),
              tipsOwedMinor: minorText(b.tipsOwed),
              tipsOwedLabel: moneyLabel(b.tipsOwed),
              receivableMinor: minorText(b.receivable),
              receivableLabel: absLabel(b.receivable),
              estimatedPayoutMinor: minorText(estimated),
              estimatedPayoutLabel: moneyLabel(estimated),
              lastSettlement: b.lastSettlement && {
                publicId: b.lastSettlement.publicId,
                numberLabel: receiptNumberLabel(b.lastSettlement.number),
                cutoffDate: b.lastSettlement.cutoffDate,
                payoutLabel: moneyLabel(b.lastSettlement.payout),
              },
            };
          }),
        totals: {
          commissionOwedLabel: moneyLabel(totals.commissionOwed),
          tipsOwedLabel: moneyLabel(totals.tipsOwed),
          receivableLabel: absLabel(totals.receivable),
        },
        canSettle: can(staff.role, "commissions.settle"),
      };
    }),
  );
}

export type StaffCommissionsView = {
  staff: { id: string; name: string; active: boolean };
  businessDate: string;
  dayClosed: boolean;
  cashSessionOpen: boolean;
  lastCutoffDate: string | null;
  suggestedCutoffDate: string;
  settlements: {
    publicId: string;
    numberLabel: string;
    businessDate: string;
    cutoffDate: string;
    payoutLabel: string;
    paidFromLabel: string | null;
    status: "settled" | "reversed";
    canReverse: boolean;
  }[];
  advances: {
    publicId: string;
    numberLabel: string;
    businessDate: string;
    amountLabel: string;
    reason: string;
    paidFromLabel: string;
    status: "active" | "reversed";
    canReverse: boolean;
  }[];
};

const staffInput = z.object({ staffId: idSchema });

export async function loadStaffCommissions(raw: z.input<typeof staffInput>): Promise<ActionResult<StaffCommissionsView>> {
  const staff = await requirePermission("commissions.view.all");
  return runAction(async () => {
    const input = staffInput.parse(raw);
    const detail = await readOnlySnapshot(conn(), (tx) => staffCommissionDetail(tx, { locationId: staff.locationId, staffId: input.staffId }));
    if (!detail) throw new SettlementError("Esa persona no existe en la sede");
    const yesterday = addDays(detail.businessDate, -1);
    return {
      staff: { id: detail.staff.id.toString(), name: detail.staff.name, active: detail.staff.active },
      businessDate: detail.businessDate,
      dayClosed: detail.dayClosed,
      cashSessionOpen: detail.cashSessionOpen,
      lastCutoffDate: detail.lastCutoffDate,
      suggestedCutoffDate: detail.lastCutoffDate !== null && detail.lastCutoffDate > yesterday ? detail.lastCutoffDate : yesterday,
      settlements: detail.settlements.map((s) => ({
        publicId: s.publicId,
        numberLabel: receiptNumberLabel(s.number),
        businessDate: s.businessDate,
        cutoffDate: s.cutoffDate,
        payoutLabel: moneyLabel(s.payout),
        paidFromLabel: s.paidFrom ? paidFromLabel(s.paidFrom) : null,
        status: s.status,
        canReverse: s.canReverse,
      })),
      advances: detail.advances.map((a) => ({
        publicId: a.publicId,
        numberLabel: receiptNumberLabel(a.number),
        businessDate: a.businessDate,
        amountLabel: moneyLabel(a.amount),
        reason: a.reason,
        paidFromLabel: paidFromLabel(a.paidFrom),
        status: a.status,
        canReverse: a.canReverse,
      })),
    };
  });
}

const previewInput = z.object({
  staffId: idSchema,
  cutoffDate: dateSchema,
  includeTips: z.boolean(),
  /** Pesos enteros; sin el campo, el máximo. */
  advanceDeductionUnits: unitsSchema("El descuento de anticipos").optional(),
  adjustments: z
    .array(
      z.object({
        direction: z.enum(["add", "deduct"]),
        amountUnits: unitsSchema("El ajuste"),
        reason: reasonSchema("el motivo del ajuste"),
      }),
    )
    .max(10, "Máximo 10 ajustes por liquidación"),
  paidFrom: paidFromSchema,
});

export type SettlementPreviewInput = z.input<typeof previewInput>;

function settlementOptions(locationId: bigint, input: z.output<typeof previewInput>, note: string | null): SettlementOptions {
  return {
    locationId,
    staffId: input.staffId,
    cutoffDate: input.cutoffDate,
    includeTips: input.includeTips,
    advanceDeduction: input.advanceDeductionUnits ?? "max",
    adjustments: input.adjustments.map((a) => ({ direction: a.direction, amount: a.amountUnits, reason: a.reason })),
    paidFrom: input.paidFrom,
    note,
  };
}

export type SettlementPreview = {
  staff: { id: string; name: string };
  cutoffDate: string;
  periodFromDate: string | null;
  businessDate: string;
  dayClosed: boolean;
  commissions: { saleLineId: string; businessDate: string; description: string; netLabel: string; rateLabel: string; commissionMinor: string; commissionLabel: string }[];
  clawbacks: { saleLineId: string; businessDate: string; description: string; settlementNumberLabel: string; amountMinor: string; amountLabel: string }[];
  waitingVoidDecision: number;
  tips: { owedMinor: string; owedLabel: string; settledMinor: string; settledLabel: string; included: boolean; mandatory: boolean };
  adjustments: { direction: "add" | "deduct"; amountLabel: string; reason: string }[];
  receivable: { outstandingMinor: string; outstandingLabel: string; maxDeductionMinor: string; maxDeductionLabel: string; deductionMinor: string; deductionLabel: string };
  totals: {
    commissionLabel: string;
    clawbackLabel: string;
    tipsLabel: string;
    adjustmentsLabel: string;
    grossMinor: string;
    grossLabel: string;
    carryOverMinor: string;
    carryOverLabel: string;
    payoutMinor: string;
    payoutLabel: string;
  };
  cash: { sessionOpen: boolean; enough: boolean };
  previewToken: string;
};

export async function loadSettlementPreview(raw: SettlementPreviewInput): Promise<ActionResult<SettlementPreview>> {
  const staff = await requirePermission("commissions.settle");
  return runAction(async () => {
    const input = previewInput.parse(raw);
    const p = await readOnlySnapshot(conn(), (tx) => previewSettlement(tx, settlementOptions(staff.locationId, input, null)));
    const d = p.draft;
    const settled = settledTips(money(p.tipsOwed)).minor;
    return {
      staff: { id: p.staff.id.toString(), name: p.staff.name },
      cutoffDate: p.cutoffDate,
      periodFromDate: p.periodFromDate,
      businessDate: p.businessDate,
      dayClosed: p.dayClosed,
      commissions: p.commissions.map((c) => ({
        saleLineId: c.saleLineId.toString(),
        businessDate: c.businessDate,
        description: c.description,
        netLabel: moneyLabel(c.net),
        rateLabel: bpsLabel(BigInt(c.commissionBps)),
        commissionMinor: minorText(c.commission),
        commissionLabel: moneyLabel(c.commission),
      })),
      clawbacks: p.clawbacks.map((c) => ({
        saleLineId: c.saleLineId.toString(),
        businessDate: c.businessDate,
        description: c.description,
        settlementNumberLabel: receiptNumberLabel(c.settlementNumber),
        amountMinor: minorText(c.commission),
        amountLabel: absLabel(c.commission),
      })),
      waitingVoidDecision: p.waitingVoidDecision,
      tips: {
        owedMinor: minorText(p.tipsOwed),
        owedLabel: moneyLabel(p.tipsOwed),
        settledMinor: minorText(settled),
        settledLabel: moneyLabel(settled),
        included: p.tipsIncluded,
        mandatory: p.tipsMandatory,
      },
      adjustments: p.adjustments.map((a) => ({ direction: a.direction, amountLabel: absLabel(a.amount.minor), reason: a.reason })),
      receivable: {
        outstandingMinor: minorText(p.receivable),
        outstandingLabel: absLabel(p.receivable),
        maxDeductionMinor: minorText(p.maxDeduction),
        maxDeductionLabel: absLabel(p.maxDeduction),
        deductionMinor: minorText(d.advanceDeduction.minor),
        deductionLabel: absLabel(d.advanceDeduction.minor),
      },
      totals: {
        commissionLabel: absLabel(d.commissionTotal.minor),
        clawbackLabel: absLabel(d.clawbackTotal.minor),
        tipsLabel: signedLabel(d.tips.minor),
        adjustmentsLabel: signedLabel(d.adjustmentsTotal.minor),
        grossMinor: minorText(d.gross.minor),
        grossLabel: moneyLabel(d.gross.minor),
        carryOverMinor: minorText(d.carryOver.minor),
        carryOverLabel: absLabel(d.carryOver.minor),
        payoutMinor: minorText(d.payout.minor),
        payoutLabel: absLabel(d.payout.minor),
      },
      cash: p.cash,
      previewToken: p.previewToken,
    };
  });
}

const settleInput = previewInput.extend({
  note: textSchema().max(300, "La nota es muy larga").optional(),
  previewToken: z.string().regex(/^[0-9a-f]{64}$/, "Vuelve a abrir la liquidación"),
  idempotencyKey: idempotencyKeySchema,
});

export async function settleCommissionsAction(
  raw: z.input<typeof settleInput>,
): Promise<ActionResult<{ publicId: string; numberLabel: string; payoutLabel: string; receiptHref: string }>> {
  const staff = await requirePermission("commissions.settle");
  return runAction(async () => {
    requireRecentAuth(staff);
    const input = settleInput.parse(raw);
    const done = await settleCommissions(conn(), {
      ...settlementOptions(staff.locationId, input, input.note || null),
      previewToken: input.previewToken,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return {
      publicId: done.publicId,
      numberLabel: receiptNumberLabel(done.number),
      payoutLabel: moneyLabel(done.payout),
      receiptHref: `/panel/comprobantes/${done.publicId}`,
    };
  });
}

const reverseInput = z.object({ publicId: publicIdSchema, reason: reasonSchema("el motivo de la reversa"), idempotencyKey: idempotencyKeySchema });

export async function reverseSettlementAction(raw: z.input<typeof reverseInput>): Promise<ActionResult> {
  const staff = await requirePermission("commissions.settle");
  return runAction(async () => {
    requireRecentAuth(staff);
    const input = reverseInput.parse(raw);
    await reverseSettlement(conn(), { locationId: staff.locationId, ...input, actor: { userId: staff.userId, role: staff.role } });
    refresh();
    return undefined;
  });
}

const advanceInput = z.object({
  staffId: idSchema,
  amountUnits: unitsSchema("El anticipo").refine((m) => m.minor > 0n, "El anticipo debe ser mayor que cero"),
  paidFrom: paidFromSchema,
  reason: reasonSchema("el motivo del anticipo"),
  idempotencyKey: idempotencyKeySchema,
});

export async function giveAdvanceAction(raw: z.input<typeof advanceInput>): Promise<ActionResult<{ publicId: string; numberLabel: string; receiptHref: string }>> {
  const staff = await requirePermission("commissions.settle");
  return runAction(async () => {
    const input = advanceInput.parse(raw);
    // Lo que sale del banco no se cuenta en ningún arqueo: exige confirmar identidad.
    requireRecentAuth(staff);
    const done = await giveAdvance(conn(), {
      locationId: staff.locationId,
      staffId: input.staffId,
      amount: input.amountUnits,
      paidFrom: input.paidFrom,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { publicId: done.publicId, numberLabel: receiptNumberLabel(done.number), receiptHref: `/panel/comprobantes/${done.publicId}` };
  });
}

export async function reverseAdvanceAction(raw: z.input<typeof reverseInput>): Promise<ActionResult> {
  const staff = await requirePermission("commissions.settle");
  return runAction(async () => {
    requireRecentAuth(staff);
    const input = reverseInput.parse(raw);
    await reverseAdvance(conn(), { locationId: staff.locationId, ...input, actor: { userId: staff.userId, role: staff.role } });
    refresh();
    return undefined;
  });
}
