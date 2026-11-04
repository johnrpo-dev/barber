"use server";

import { today } from "@/db/cash";
import { db } from "@/db/client";
import { commissionBalances, pendingClawbacks, pendingCommissions, staffCommissionDetail } from "@/db/commissions";
import { readOnlySnapshot } from "@/db/reports";
import type { Db } from "@/db/types";
import { estimatedPayout, receiptNumberLabel } from "@/domain/commissions/settlement";
import { money } from "@/domain/money";
import { bpsLabel } from "@/domain/reports/rates";
import { type ActionResult, runAction } from "@/lib/action";
import { absLabel, minorText, moneyLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";

// Mis comisiones (docs/sprint-5-comisiones-informes.md §10): la persona sale de la sesión, nunca del
// navegador, y por eso esta acción no recibe ningún dato. Sin nada de otras personas ni de clientes.

const MAX_PENDING_LINES = 200;

export type MyCommissionsView = {
  name: string;
  businessDate: string;
  pending: {
    totalMinor: string;
    totalLabel: string;
    lines: { businessDate: string; description: string; netLabel: string; rateLabel: string; commissionLabel: string }[];
  };
  clawbacks: { businessDate: string; description: string; amountLabel: string }[];
  tipsOwedLabel: string;
  receivableLabel: string;
  estimatedPayoutLabel: string;
  settlements: { publicId: string; numberLabel: string; businessDate: string; cutoffDate: string; payoutLabel: string; status: "settled" | "reversed" }[];
  advances: { publicId: string; numberLabel: string; businessDate: string; amountLabel: string; status: "active" | "reversed" }[];
};

export async function loadMyCommissions(): Promise<ActionResult<MyCommissionsView>> {
  const staff = await requirePermission("commissions.view.own");
  return runAction(async () =>
    readOnlySnapshot(db() as unknown as Db, async (tx) => {
      const scope = { locationId: staff.locationId, staffId: staff.staffId };
      const day = await today(tx, staff.locationId);
      const [balance] = await commissionBalances(tx, staff.locationId, { staffId: staff.staffId });
      const lines = await pendingCommissions(tx, { ...scope, cutoffDate: day.businessDate, limit: MAX_PENDING_LINES });
      const clawbacks = await pendingClawbacks(tx, scope);
      const detail = await staffCommissionDetail(tx, scope);
      const pending = balance?.pendingCommission ?? 0n;
      const tips = balance?.tipsOwed ?? 0n;
      const receivable = balance?.receivable ?? 0n;
      return {
        name: staff.name,
        businessDate: day.businessDate,
        pending: {
          totalMinor: minorText(pending),
          totalLabel: moneyLabel(pending),
          lines: lines.map((l) => ({
            businessDate: l.businessDate,
            description: l.description,
            netLabel: moneyLabel(l.net),
            rateLabel: bpsLabel(BigInt(l.commissionBps)),
            commissionLabel: moneyLabel(l.commission),
          })),
        },
        clawbacks: clawbacks.map((c) => ({ businessDate: c.businessDate, description: c.description, amountLabel: absLabel(c.commission) })),
        tipsOwedLabel: moneyLabel(tips),
        receivableLabel: absLabel(receivable),
        estimatedPayoutLabel: moneyLabel(
          estimatedPayout({
            commission: money(pending),
            clawbacks: money(balance?.clawbacks ?? 0n),
            tipsOwed: money(tips),
            receivable: money(receivable),
          }).minor,
        ),
        settlements: (detail?.settlements ?? []).map((s) => ({
          publicId: s.publicId,
          numberLabel: receiptNumberLabel(s.number),
          businessDate: s.businessDate,
          cutoffDate: s.cutoffDate,
          payoutLabel: moneyLabel(s.payout),
          status: s.status,
        })),
        advances: (detail?.advances ?? []).map((a) => ({
          publicId: a.publicId,
          numberLabel: receiptNumberLabel(a.number),
          businessDate: a.businessDate,
          amountLabel: moneyLabel(a.amount),
          status: a.status,
        })),
      };
    }),
  );
}
