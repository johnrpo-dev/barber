"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import { paidSalesCount, saleReceipt, salesOfDay } from "@/db/receipts";
import type { Db } from "@/db/types";
import { isUlid } from "@/db/ulid";
import { cashSessionsInPeriod, salesByDay } from "@/db/history";
import { readOnlySnapshot } from "@/db/reports";
import { formatPhone } from "@/domain/clients/client";
import { historyPeriod, type HistoryPeriodView } from "@/domain/reports/period";
import { saleNumber } from "@/domain/sales/receipt-number";
import { can } from "@/domain/staff/roles";
import { type ActionResult, runAction } from "@/lib/action";
import { absLabel, moneyLabel, timeLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";
import { dayShort } from "../_components/dates";

// Ventas y recibo impreso (no es factura electrónica). Quien cobra (ledger.post) ve las ventas de
// HOY y reimprime sus recibos; el dueño (reports.financial) ve cualquier día. Un id que no es ULID,
// que no existe, que es de otra sede o de un día que no le toca a quien mira da el mismo 404.
// Sin datos del cliente.

const database = () => db() as unknown as Db;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface SaleReceiptView {
  publicId: string;
  /** Últimos 8 caracteres del ULID, para leerlo en voz alta o buscarlo. */
  numberLabel: string;
  businessDate: string;
  timeLabel: string;
  voided: boolean;
  location: { name: string; address: string | null; phoneLabel: string | null; taxId: string | null; footer: string | null };
  chargedByName: string | null;
  lines: { description: string; staffName: string; unitPriceLabel: string; hasQuantity: boolean; discountLabel: string | null; netLabel: string }[];
  subtotalLabel: string;
  discountLabel: string | null;
  tips: { staffName: string; amountLabel: string }[];
  totalLabel: string;
  payments: { label: string; amountLabel: string; tenderedLabel: string | null }[];
  changeLabel: string | null;
}

const receiptInput = z.object({ publicId: z.string().max(40) });

export async function loadSaleReceipt(raw: z.input<typeof receiptInput>): Promise<ActionResult<SaleReceiptView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const { publicId } = receiptInput.parse(raw);
    if (!isUlid(publicId)) notFound();
    const conn = database();
    const r = await saleReceipt(conn, { locationId: staff.locationId, publicId });
    if (!r) notFound();
    if (!can(staff.role, "reports.financial")) {
      const day = await today(conn, staff.locationId);
      if (r.businessDate !== day.businessDate) notFound();
    }
    const change = r.payments.reduce((acc, p) => acc + (p.change ?? 0n), 0n);
    return {
      publicId: r.publicId,
      numberLabel: saleNumber(r.publicId),
      businessDate: r.businessDate,
      timeLabel: timeLabel(r.createdAt, r.location.timeZone),
      voided: r.status === "voided",
      location: {
        name: r.location.name,
        address: r.location.address,
        phoneLabel: r.location.publicPhone ? formatPhone(r.location.publicPhone) : null,
        taxId: r.location.taxId,
        footer: r.location.receiptFooter,
      },
      chargedByName: r.chargedByName,
      lines: r.lines.map((l) => ({
        description: l.quantity > 1 ? `${l.description} ×${l.quantity}` : l.description,
        staffName: l.staffName,
        // Con unidades: "2 × $25.000"; de a uno, el precio.
        unitPriceLabel: l.quantity > 1 ? `${l.quantity} × ${moneyLabel(l.unitPrice)}` : moneyLabel(l.unitPrice),
        hasQuantity: l.quantity > 1,
        discountLabel: l.discount > 0n ? `-${absLabel(l.discount)}` : null,
        netLabel: moneyLabel(l.net),
      })),
      subtotalLabel: moneyLabel(r.subtotal),
      discountLabel: r.discount > 0n ? `-${absLabel(r.discount)}` : null,
      tips: r.tipLines.map((t) => ({ staffName: t.staffName, amountLabel: moneyLabel(t.amount) })),
      totalLabel: moneyLabel(r.totalPaid),
      payments: r.payments.map((p) => ({
        label: p.label,
        amountLabel: moneyLabel(p.amount),
        tenderedLabel: p.tendered !== null && p.change !== null && p.change > 0n ? moneyLabel(p.tendered) : null,
      })),
      changeLabel: change > 0n ? moneyLabel(change) : null,
    };
  });
}

export interface SalesDayView {
  businessDate: string;
  today: string;
  /** Si quien mira puede ver otros días (el dueño). */
  canPickDay: boolean;
  sales: {
    publicId: string;
    numberLabel: string;
    timeLabel: string;
    voided: boolean;
    /** Día de la anulación si fue otro día (la reversa va ese día, no en este): "YYYY-MM-DD". */
    voidedLaterOn: string | null;
    totalLabel: string;
    services: string;
    staff: string;
  }[];
  /** Ventas del día que no se anularon ese mismo día (la misma regla del historial). */
  paidCount: number;
}

const dayInput = z.object({ date: z.string().max(10).optional() });

export async function loadSalesOfDay(raw: z.input<typeof dayInput>): Promise<ActionResult<SalesDayView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const { date } = dayInput.parse(raw);
    const conn = database();
    const day = await today(conn, staff.locationId);
    const canPickDay = can(staff.role, "reports.financial");
    // Sin permiso para otros días, se muestra hoy sin importar lo que pida la dirección.
    const businessDate = canPickDay && date && DAY.test(date) && date <= day.businessDate ? date : day.businessDate;
    const rows = await salesOfDay(conn, { locationId: staff.locationId, businessDate });
    const sales = rows.map((s) => ({
      publicId: s.publicId,
      numberLabel: saleNumber(s.publicId),
      timeLabel: timeLabel(s.createdAt, day.timeZone),
      voided: s.status === "voided",
      voidedLaterOn: s.voidedOn && s.voidedOn !== businessDate ? s.voidedOn : null,
      totalLabel: moneyLabel(s.totalPaid),
      services: s.services.join(", "),
      staff: s.staffNames.join(", "),
    }));
    const paidCount = await paidSalesCount(conn, { locationId: staff.locationId, businessDate });
    return { businessDate, today: day.businessDate, canPickDay, sales, paidCount };
  });
}

export interface SalesHistoryView {
  period: HistoryPeriodView;
  days: {
    date: string;
    paid: number;
    voided: number;
    totalLabel: string;
    tipsLabel: string;
    cashLabel: string;
    otherLabel: string;
    /** Turnos de caja abiertos ese día: quién abrió y quién cerró, con la hora (registro del día). */
    shifts: { openedBy: string; openedTime: string; closedBy: string | null; closedLabel: string | null }[];
  }[];
  total: { paid: number; voided: number; totalLabel: string; tipsLabel: string; cashLabel: string; otherLabel: string };
}

const historyInput = z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() });

/**
 * Historial de ventas del dueño: una fila por día del periodo (por defecto, este mes), con el total
 * sumado en SQL. El detalle de cada día está en /panel/ventas?dia=… y el archivo, en Exportar.
 */
export async function loadSalesHistory(raw: z.input<typeof historyInput>): Promise<ActionResult<SalesHistoryView>> {
  const staff = await requirePermission("reports.financial");
  return runAction(async () => {
    const input = historyInput.parse(raw);
    return readOnlySnapshot(database(), async (tx) => {
      const day = await today(tx, staff.locationId);
      const period = historyPeriod(day.businessDate, input.from, input.to);
      const q = { locationId: staff.locationId, from: period.from, to: period.to };
      const data = await salesByDay(tx, q);
      const { sessions } = await cashSessionsInPeriod(tx, q);
      const labels = (r: { total: bigint; tips: bigint; cash: bigint; other: bigint }) => ({
        totalLabel: moneyLabel(r.total),
        tipsLabel: moneyLabel(r.tips),
        cashLabel: moneyLabel(r.cash),
        otherLabel: moneyLabel(r.other),
      });
      // Turnos por día de apertura, del primero al último del día. Un día con caja y sin ventas también se lista.
      const shiftsByDay = new Map<string, SalesHistoryView["days"][number]["shifts"]>();
      for (const c of [...sessions].reverse()) {
        const list = shiftsByDay.get(c.openedDate) ?? [];
        list.push({
          openedBy: c.openedBy,
          openedTime: c.openedTime,
          closedBy: c.closedBy,
          // Un cierre tardío (otro día) lleva la fecha.
          closedLabel: c.closedTime === null ? null : c.closedDate === c.openedDate ? c.closedTime : `${dayShort(c.closedDate!)} ${c.closedTime}`,
        });
        shiftsByDay.set(c.openedDate, list);
      }
      const zero = labels({ total: 0n, tips: 0n, cash: 0n, other: 0n });
      const days: SalesHistoryView["days"] = data.days.map((r) => ({
        date: r.businessDate!,
        paid: r.paid,
        voided: r.voided,
        ...labels(r),
        shifts: shiftsByDay.get(r.businessDate!) ?? [],
      }));
      for (const [date, shifts] of shiftsByDay) {
        if (!days.some((d) => d.date === date)) days.push({ date, paid: 0, voided: 0, ...zero, shifts });
      }
      days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return {
        period,
        days,
        total: { paid: data.total.paid, voided: data.total.voided, ...labels(data.total) },
      };
    });
  });
}
