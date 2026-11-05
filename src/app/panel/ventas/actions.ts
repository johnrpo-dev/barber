"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import { saleReceipt, salesOfDay } from "@/db/receipts";
import type { Db } from "@/db/types";
import { isUlid } from "@/db/ulid";
import { formatPhone } from "@/domain/clients/client";
import { can } from "@/domain/staff/roles";
import { type ActionResult, runAction } from "@/lib/action";
import { absLabel, moneyLabel, timeLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";

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
  lines: { description: string; staffName: string; unitPriceLabel: string; discountLabel: string | null; netLabel: string }[];
  subtotalLabel: string;
  discountLabel: string | null;
  tips: { staffName: string; amountLabel: string }[];
  totalLabel: string;
  payments: { label: string; amountLabel: string; tenderedLabel: string | null }[];
  changeLabel: string | null;
}

/** Últimos 8 caracteres del ULID (no se exporta: en un archivo "use server" sería una acción pública). */
const receiptNumber = (publicId: string): string => publicId.slice(-8);

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
      numberLabel: receiptNumber(r.publicId),
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
        description: l.description,
        staffName: l.staffName,
        unitPriceLabel: moneyLabel(l.unitPrice),
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
  sales: { publicId: string; numberLabel: string; timeLabel: string; voided: boolean; totalLabel: string; services: string; staff: string }[];
  /** Cuántas ventas del día siguen pagadas (las anuladas se listan aparte con su sello). */
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
      numberLabel: receiptNumber(s.publicId),
      timeLabel: timeLabel(s.createdAt, day.timeZone),
      voided: s.status === "voided",
      totalLabel: moneyLabel(s.totalPaid),
      services: s.services.join(", "),
      staff: s.staffNames.join(", "),
    }));
    return { businessDate, today: day.businessDate, canPickDay, sales, paidCount: rows.filter((s) => s.status === "paid").length };
  });
}
