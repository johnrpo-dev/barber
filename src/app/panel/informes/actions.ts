"use server";

import { z } from "zod";
import { recordAudit } from "@/db/audit";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import { cashSessionsInPeriod, salesDetail } from "@/db/history";
import {
  cardFees,
  cashDifferences,
  courtesiesByStaff,
  expensesByCategory,
  journalDetail,
  noShowStats,
  paymentMix,
  profitAndLoss,
  readOnlySnapshot,
  salesByService,
  salesByStaff,
  settlementsInPeriod,
  tipsByStaff,
} from "@/db/reports";
import type { Db } from "@/db/types";
import { receiptNumberLabel } from "@/domain/commissions/settlement";
import { money } from "@/domain/money";
import { saleNumber } from "@/domain/sales/receipt-number";
import { CSV_MAX_ROWS, CSV_REPORTS, type CsvCell, type CsvReport, csvFilename, toCsv } from "@/domain/reports/csv";
import { type PeriodPreset, PERIOD_PRESET_LABELS, PERIOD_PRESETS, periodLabel, presetPeriod, type ReportPeriod, reportPeriod } from "@/domain/reports/period";
import type { EntryKind } from "@/domain/ledger/entry";
import { assemblePnl } from "@/domain/reports/pnl";
import { bpsLabel, rateBps } from "@/domain/reports/rates";
import { type ActionResult, runAction } from "@/lib/action";
import { dateSchema } from "@/lib/action-schemas";
import { absLabel, minorText, moneyLabel, signedLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";

// Informes del dueño (docs/sprint-5-comisiones-informes.md §6 y §12.3). Todo se suma en SQL, en una
// sola foto de solo lectura; aquí solo se da formato. Cada exportación deja su evento de auditoría.

const conn = () => db() as unknown as Db;
const share = (part: bigint, whole: bigint): string | null => {
  const bps = rateBps(part, whole);
  return bps === null ? null : bpsLabel(bps);
};

export type AmountRow = { code: string; name: string; amountMinor: string; amountLabel: string };

export type ReportView = {
  period: { from: string; to: string; label: string };
  presets: { key: PeriodPreset; label: string; from: string; to: string }[];
  pnl: {
    income: AmountRow[];
    expenses: AmountRow[];
    totalIncomeMinor: string;
    totalIncomeLabel: string;
    totalExpensesMinor: string;
    totalExpensesLabel: string;
    profitMinor: string;
    profitLabel: string;
    marginLabel: string | null;
  };
  byStaff: { staffId: string; name: string; services: number; grossLabel: string; discountLabel: string; netMinor: string; netLabel: string; commissionLabel: string; tipsLabel: string }[];
  byService: { serviceId: string; name: string; services: number; netMinor: string; netLabel: string; shareLabel: string | null }[];
  payments: { kind: "cash" | "card" | "transfer" | "wallet"; label: string; payments: number; amountMinor: string; amountLabel: string; feesLabel: string; shareLabel: string | null }[];
  tips: { rows: { staffId: string; name: string; tipsLabel: string; feeShareLabel: string; payableLabel: string; paidOutLabel: string }[]; totalLabel: string };
  cardFees: { totalLabel: string; byMethod: { label: string; feesLabel: string }[] };
  expenses: { name: string; paidFrom: "cash" | "bank"; count: number; amountLabel: string }[];
  cashDifferences: {
    netMinor: string;
    netLabel: string;
    items: { businessDate: string; moment: "opening" | "closing"; differenceLabel: string; sign: "+" | "-"; note: string | null; by: string }[];
  };
  noShow: {
    reservations: number;
    completed: number;
    noShow: number;
    cancelled: number;
    lateCancelled: number;
    rateLabel: string | null;
    byStaff: { name: string; completed: number; noShow: number; rateLabel: string | null }[];
  };
  settlements: { publicId: string; numberLabel: string; staffName: string; cutoffDate: string; businessDate: string; payoutLabel: string; status: "settled" | "reversed" }[];
  /** Cortesías por quien atendió: cantidad y precio de lista sumado en SQL (sprint 8, §4). */
  courtesies: { rows: { staffId: string; name: string; courtesies: number; listPriceLabel: string }[]; total: number; totalListPriceLabel: string };
};

const periodInput = z.object({ from: dateSchema, to: dateSchema });
const amountRow = (l: { code: string; name: string; amount: { minor: bigint } }): AmountRow => ({
  code: l.code,
  name: l.name,
  amountMinor: minorText(l.amount.minor),
  amountLabel: moneyLabel(l.amount.minor),
});

export async function loadReport(raw: z.input<typeof periodInput>): Promise<ActionResult<ReportView>> {
  const staff = await requirePermission("reports.financial");
  return runAction(async () => {
    const input = periodInput.parse(raw);
    const period = reportPeriod(input.from, input.to);
    return readOnlySnapshot(conn(), async (tx) => {
      const q = { locationId: staff.locationId, ...period };
      const day = await today(tx, staff.locationId);
      const pnlData = await profitAndLoss(tx, q);
      const pnl = assemblePnl(pnlData.rows, pnlData.totals);
      const byStaff = await salesByStaff(tx, q);
      const byService = await salesByService(tx, q);
      const payments = await paymentMix(tx, q);
      const tips = await tipsByStaff(tx, q);
      const fees = await cardFees(tx, q);
      const expenses = await expensesByCategory(tx, q);
      const differences = await cashDifferences(tx, q);
      const noShow = await noShowStats(tx, { ...q, timeZone: day.timeZone });
      const settlements = await settlementsInPeriod(tx, q);
      const courtesies = await courtesiesByStaff(tx, q);
      const noShowRate = (r: { noShow: number; completed: number }) => share(BigInt(r.noShow), BigInt(r.completed + r.noShow));
      return {
        period: { from: period.from, to: period.to, label: periodLabel(period) },
        presets: PERIOD_PRESETS.map((key) => ({ key, label: PERIOD_PRESET_LABELS[key], ...presetPeriod(key, day.businessDate) })),
        pnl: {
          income: pnl.income.map(amountRow),
          expenses: pnl.expenses.map(amountRow),
          totalIncomeMinor: minorText(pnl.totalIncome.minor),
          totalIncomeLabel: moneyLabel(pnl.totalIncome.minor),
          totalExpensesMinor: minorText(pnl.totalExpenses.minor),
          totalExpensesLabel: moneyLabel(pnl.totalExpenses.minor),
          profitMinor: minorText(pnl.profit.minor),
          profitLabel: moneyLabel(pnl.profit.minor),
          marginLabel: share(pnl.profit.minor, pnl.totalIncome.minor),
        },
        byStaff: byStaff.map((r) => ({
          staffId: r.staffId.toString(),
          name: r.name,
          services: r.services,
          grossLabel: moneyLabel(r.gross),
          discountLabel: moneyLabel(r.discount),
          netMinor: minorText(r.net),
          netLabel: moneyLabel(r.net),
          commissionLabel: moneyLabel(r.commission),
          tipsLabel: moneyLabel(r.tips),
        })),
        byService: byService.map((r) => ({
          serviceId: r.serviceId.toString(),
          name: r.name,
          services: r.services,
          netMinor: minorText(r.net),
          netLabel: moneyLabel(r.net),
          shareLabel: share(r.net, r.totalNet),
        })),
        payments: payments.map((r) => ({
          kind: r.kind,
          label: r.label,
          payments: r.payments,
          amountMinor: minorText(r.amount),
          amountLabel: moneyLabel(r.amount),
          feesLabel: moneyLabel(r.fees),
          shareLabel: share(r.amount, r.totalAmount),
        })),
        tips: {
          rows: tips.map((r) => ({
            staffId: r.staffId.toString(),
            name: r.name,
            tipsLabel: moneyLabel(r.tips),
            feeShareLabel: moneyLabel(r.feeShare),
            payableLabel: moneyLabel(r.payable),
            paidOutLabel: moneyLabel(r.paidOut),
          })),
          totalLabel: moneyLabel(tips[0]?.totalTips ?? 0n),
        },
        cardFees: {
          totalLabel: moneyLabel(fees.ledgerTotal),
          byMethod: [
            ...fees.byMethod.map((m) => ({ label: m.label, feesLabel: moneyLabel(m.fees) })),
            // Sin esta fila, con "las propinas asumen el datáfono" los medios no cuadran con el total (5305).
            ...(fees.absorbedByTips > 0n ? [{ label: "Parte absorbida por las propinas", feesLabel: moneyLabel(-fees.absorbedByTips) }] : []),
          ],
        },
        expenses: expenses.map((r) => ({ name: r.name, paidFrom: r.paidFrom, count: r.count, amountLabel: moneyLabel(r.amount) })),
        cashDifferences: {
          netMinor: minorText(differences.net),
          netLabel: signedLabel(differences.net),
          items: differences.items.map((c) => ({
            businessDate: c.businessDate,
            moment: c.moment,
            differenceLabel: absLabel(c.difference),
            sign: c.difference >= 0n ? ("+" as const) : ("-" as const),
            note: c.note,
            by: c.by,
          })),
        },
        noShow: {
          reservations: noShow.total.reservations,
          completed: noShow.total.completed,
          noShow: noShow.total.noShow,
          cancelled: noShow.total.cancelled,
          lateCancelled: noShow.total.lateCancelled,
          rateLabel: noShowRate(noShow.total),
          byStaff: noShow.byStaff.map((r) => ({ name: r.name, completed: r.completed, noShow: r.noShow, rateLabel: noShowRate(r) })),
        },
        settlements: settlements.map((s) => ({
          publicId: s.publicId,
          numberLabel: receiptNumberLabel(s.number),
          staffName: s.staffName,
          cutoffDate: s.cutoffDate,
          businessDate: s.businessDate,
          payoutLabel: moneyLabel(s.payout),
          status: s.status,
        })),
        courtesies: {
          rows: courtesies.rows.map((c) => ({ staffId: c.staffId.toString(), name: c.name, courtesies: c.courtesies, listPriceLabel: moneyLabel(c.listPrice) })),
          total: courtesies.total.courtesies,
          totalListPriceLabel: moneyLabel(courtesies.total.listPrice),
        },
      };
    });
  });
}

const exportInput = periodInput.extend({ report: z.enum(CSV_REPORTS) });

/**
 * Etiqueta fija por tipo de asiento: el memo es texto libre (una reversa lleva el motivo de la
 * anulación, que puede traer datos del cliente) y no sale en un archivo. El libro en el sistema lo
 * conserva completo.
 */
const ENTRY_KIND_LABELS: Record<EntryKind, string> = {
  sale: "Venta",
  expense: "Gasto",
  commission_payout: "Liquidación de comisiones",
  tip_payout: "Pago de propinas",
  cash_deposit: "Consignación",
  cash_adjustment: "Ajuste de caja",
  owner_contribution: "Aporte del dueño",
  owner_withdrawal: "Retiro del dueño",
  reversal: "Reversa",
  staff_advance: "Anticipo",
};

const text = (v: string | null): CsvCell => ({ text: v ?? "" });
const pesos = (minor: bigint): CsvCell => ({ money: money(minor) });
const date = (v: string): CsvCell => ({ date: v });
const count = (n: number): CsvCell => ({ count: BigInt(n) });

async function csvContent(tx: Db, report: CsvReport, locationId: bigint, period: ReportPeriod): Promise<{ header: string[]; rows: CsvCell[][] }> {
  const q = { locationId, ...period };
  switch (report) {
    case "pnl": {
      const data = await profitAndLoss(tx, q);
      const pnl = assemblePnl(data.rows, data.totals);
      return {
        header: ["Tipo", "Cuenta", "Nombre", "Monto"],
        rows: [
          ...pnl.income.map((l) => [text("Ingreso"), text(l.code), text(l.name), pesos(l.amount.minor)]),
          [text("Total"), text(""), text("Total ingresos"), pesos(pnl.totalIncome.minor)],
          ...pnl.expenses.map((l) => [text("Gasto"), text(l.code), text(l.name), pesos(l.amount.minor)]),
          [text("Total"), text(""), text("Total gastos"), pesos(pnl.totalExpenses.minor)],
          [text("Total"), text(""), text("Utilidad"), pesos(pnl.profit.minor)],
        ],
      };
    }
    case "journal": {
      // Uno más que el tope: toCsv rechaza el archivo con el mensaje de exportar por meses.
      const rows = await journalDetail(tx, { ...q, limit: CSV_MAX_ROWS + 1 });
      return {
        header: ["Fecha", "Asiento", "Tipo", "Cuenta", "Nombre de la cuenta", "Débito", "Crédito"],
        rows: rows.map((r) => [date(r.businessDate), text(r.entryId.toString()), text(ENTRY_KIND_LABELS[r.kind as EntryKind]), text(r.code), text(r.accountName), pesos(r.debit), pesos(r.credit)]),
      };
    }
    case "by_staff":
      return {
        header: ["Persona", "Servicios", "Bruto", "Descuentos", "Neto", "Comisión", "Propinas"],
        rows: (await salesByStaff(tx, q)).map((r) => [text(r.name), count(r.services), pesos(r.gross), pesos(r.discount), pesos(r.net), pesos(r.commission), pesos(r.tips)]),
      };
    case "by_service":
      return {
        header: ["Servicio", "Cantidad", "Bruto", "Descuentos", "Neto", "Comisión"],
        rows: (await salesByService(tx, q)).map((r) => [text(r.name), count(r.services), pesos(r.gross), pesos(r.discount), pesos(r.net), pesos(r.commission)]),
      };
    case "payments":
      return {
        header: ["Medio", "Tipo", "Pagos", "Monto", "Costo del medio"],
        rows: (await paymentMix(tx, q)).map((r) => [text(r.label), text(r.kind), count(r.payments), pesos(r.amount), pesos(r.fees)]),
      };
    case "tips":
      return {
        header: ["Persona", "Recibidas", "Parte del datáfono", "Por pagar causadas", "Pagadas en el periodo"],
        rows: (await tipsByStaff(tx, q)).map((r) => [text(r.name), pesos(r.tips), pesos(r.feeShare), pesos(r.payable), pesos(r.paidOut)]),
      };
    case "expenses":
      return {
        header: ["Categoría", "Origen", "Cantidad", "Monto"],
        rows: (await expensesByCategory(tx, q)).map((r) => [text(r.name), text(r.paidFrom === "cash" ? "Caja" : "Banco"), count(r.count), pesos(r.amount)]),
      };
    case "cash_differences":
      return {
        // Sin la nota del conteo: es texto libre y no sale en un archivo; se ve en pantalla.
        header: ["Fecha", "Momento", "Diferencia", "Contó"],
        rows: (await cashDifferences(tx, q)).items.map((r) => [date(r.businessDate), text(r.moment === "opening" ? "Apertura" : "Cierre"), pesos(r.difference), text(r.by)]),
      };
    case "settlements":
      return {
        header: ["Número", "Persona", "Corte", "Fecha de pago", "Pago", "Origen", "Estado"],
        rows: (await settlementsInPeriod(tx, q)).map((r) => [
          text(receiptNumberLabel(r.number)),
          text(r.staffName),
          date(r.cutoffDate),
          date(r.businessDate),
          pesos(r.payout),
          text(r.paidFrom === null ? "Sin pago" : r.paidFrom === "cash" ? "Caja" : "Banco"),
          text(r.status === "settled" ? "Vigente" : "Revertida"),
        ]),
      };
    case "sales": {
      // Una fila por venta, en el día en que se cobró, anuladas incluidas (marcadas con el día de la
      // anulación: la reversa va ese día). Sin datos del cliente.
      const rows = await salesDetail(tx, { ...q, limit: CSV_MAX_ROWS + 1 });
      return {
        header: ["Fecha", "Hora", "Número", "Estado", "Anulada el (día contable)", "Servicios", "Atendió", "Servicios (bruto)", "Descuento", "Propina", "Total cobrado", "Efectivo", "Otros medios", "Medios"],
        rows: rows.map((r) => [
          date(r.businessDate),
          text(r.time),
          text(saleNumber(r.publicId)),
          text(r.status === "paid" ? "Vigente" : "Anulada"),
          r.voidedOn ? date(r.voidedOn) : text(""),
          text(r.services),
          text(r.staff),
          pesos(r.subtotal),
          pesos(r.discount),
          pesos(r.tips),
          pesos(r.total),
          pesos(r.cash),
          pesos(r.other),
          text(r.methods),
        ]),
      };
    }
    case "cash_sessions":
      return {
        // Sin las notas del conteo: son texto libre y no salen en un archivo; se ven en pantalla.
        header: ["Abrió el", "Hora", "Abrió (responsable de la apertura)", "Base contada", "Diferencia de apertura", "Cerró el", "Hora de cierre", "Cerró (responsable del cierre)", "Esperado", "Contado", "Diferencia de cierre", "Revisión"],
        rows: (await cashSessionsInPeriod(tx, q)).sessions.map((r) => [
          date(r.openedDate),
          text(r.openedTime),
          text(r.openedBy),
          pesos(r.openingCounted),
          pesos(r.openingDifference),
          r.closedDate ? date(r.closedDate) : text("Abierta"),
          text(r.closedTime ?? ""),
          text(r.closedBy ?? ""),
          r.expected === null ? text("") : pesos(r.expected),
          r.closingCounted === null ? text("") : pesos(r.closingCounted),
          r.difference === null ? text("") : pesos(r.difference),
          text(!r.flagged ? "" : r.reviewed ? `Revisada${r.reviewedBy ? ` por ${r.reviewedBy}` : ""}` : "Pendiente de revisión"),
        ]),
      };
    case "courtesies":
      return {
        // Sin el motivo: es texto libre y puede nombrar al cliente.
        header: ["Persona", "Cortesías", "Precio de lista"],
        rows: (await courtesiesByStaff(tx, q)).rows.map((r) => [text(r.name), count(r.courtesies), pesos(r.listPrice)]),
      };
  }
}

export async function exportReportCsvAction(raw: z.input<typeof exportInput>): Promise<ActionResult<{ filename: string; csv: string }>> {
  const staff = await requirePermission("reports.financial");
  return runAction(async () => {
    const input = exportInput.parse(raw);
    const period = reportPeriod(input.from, input.to);
    const content = await readOnlySnapshot(conn(), (tx) => csvContent(tx, input.report, staff.locationId, period));
    const csv = toCsv(content.header, content.rows);
    const filename = csvFilename(input.report, period);
    // Solo se registra una exportación que de verdad se entregó.
    await recordAudit(conn(), {
      locationId: staff.locationId,
      actorUserId: staff.userId,
      actorStaffId: staff.staffId,
      action: "report.export",
      targetKind: "report",
      targetRef: input.report,
      summary: `Exportó ${filename}`,
    });
    return { filename, csv };
  });
}
