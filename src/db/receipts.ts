import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { saleNumber } from "@/domain/sales/receipt-number";
import { instantLabels } from "@/domain/booking/public-labels";
import { format, money } from "@/domain/money";
import { firstNameForMessage, type NotificationChannel } from "@/domain/notifications/templates";
import { enqueueNotification, preferredChannel } from "./notifications";
import { clients, locations, saleLines, salePayments, sales, saleTips, staffMembers } from "./schema";
import type { Db } from "./types";

// Recibo impreso de una venta y el historial para reimprimir. No es factura electrónica.
// Sin datos del cliente: ni nombre ni celular salen en un papel que se queda en el mostrador.
// Todo se lee de lo guardado al cobrar (líneas, pagos y propinas congelados): reimprimir hoy o en
// un mes da el mismo papel, salvo el sello de ANULADA si la venta se anuló después.

export interface SaleReceipt {
  publicId: string;
  businessDate: string;
  createdAt: Date;
  status: "paid" | "voided";
  voidedAt: Date | null;
  location: {
    name: string;
    timeZone: string;
    address: string | null;
    publicPhone: string | null;
    taxId: string | null;
    receiptFooter: string | null;
  };
  /** Nombre en la sede de quien cobró (null si ya no tiene membresía). */
  chargedByName: string | null;
  subtotal: bigint;
  discount: bigint;
  tips: bigint;
  totalPaid: bigint;
  lines: { description: string; staffName: string; unitPrice: bigint; discount: bigint; net: bigint }[];
  tipLines: { staffName: string; amount: bigint }[];
  payments: { kind: string; label: string; amount: bigint; tendered: bigint | null; change: bigint | null }[];
}

/** Recibo de una venta de ESTA sede por su ULID público; null si no existe aquí. */
export async function saleReceipt(db: Db, input: { locationId: bigint; publicId: string }): Promise<SaleReceipt | null> {
  const [sale] = await db
    .select({
      id: sales.id,
      publicId: sales.publicId,
      businessDate: sales.businessDate,
      createdAt: sales.createdAt,
      status: sales.status,
      voidedAt: sales.voidedAt,
      subtotal: sales.subtotal,
      discount: sales.discount,
      tips: sales.tips,
      totalPaid: sales.totalPaid,
      chargedByName: staffMembers.displayName,
      locationName: locations.name,
      timeZone: locations.timezone,
      address: locations.address,
      publicPhone: locations.publicPhone,
      taxId: locations.taxId,
      receiptFooter: locations.receiptFooter,
    })
    .from(sales)
    .innerJoin(locations, eq(locations.id, sales.locationId))
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, sales.locationId), eq(staffMembers.userId, sales.createdBy)))
    .where(and(eq(sales.locationId, input.locationId), eq(sales.publicId, input.publicId)));
  if (!sale) return null;

  const [lines, tipLines, payments] = await Promise.all([
    db
      .select({
        description: saleLines.description,
        staffName: staffMembers.displayName,
        unitPrice: saleLines.unitPrice,
        discount: saleLines.discount,
        net: saleLines.net,
      })
      .from(saleLines)
      .innerJoin(staffMembers, and(eq(staffMembers.locationId, saleLines.locationId), eq(staffMembers.id, saleLines.staffId)))
      .where(and(eq(saleLines.locationId, input.locationId), eq(saleLines.saleId, sale.id)))
      .orderBy(asc(saleLines.position)),
    db
      .select({ staffName: staffMembers.displayName, amount: saleTips.amount })
      .from(saleTips)
      .innerJoin(staffMembers, and(eq(staffMembers.locationId, saleTips.locationId), eq(staffMembers.id, saleTips.staffId)))
      .where(and(eq(saleTips.locationId, input.locationId), eq(saleTips.saleId, sale.id)))
      .orderBy(asc(saleTips.id)),
    db
      .select({
        kind: salePayments.kind,
        label: salePayments.label,
        amount: salePayments.amount,
        tendered: salePayments.tendered,
        change: salePayments.change,
      })
      .from(salePayments)
      .where(and(eq(salePayments.locationId, input.locationId), eq(salePayments.saleId, sale.id)))
      .orderBy(asc(salePayments.id)),
  ]);

  return {
    publicId: sale.publicId,
    businessDate: sale.businessDate,
    createdAt: sale.createdAt,
    status: sale.status,
    voidedAt: sale.voidedAt,
    location: {
      name: sale.locationName,
      timeZone: sale.timeZone,
      address: sale.address,
      publicPhone: sale.publicPhone,
      taxId: sale.taxId,
      receiptFooter: sale.receiptFooter,
    },
    chargedByName: sale.chargedByName,
    subtotal: sale.subtotal,
    discount: sale.discount,
    tips: sale.tips,
    totalPaid: sale.totalPaid,
    lines,
    tipLines,
    payments,
  };
}

export interface SaleListRow {
  publicId: string;
  createdAt: Date;
  status: "paid" | "voided";
  /** Día contable de la anulación (la reversa va el día en que se aprueba), o null si sigue vigente. */
  voidedOn: string | null;
  totalPaid: bigint;
  /** Descripciones de las líneas en orden ("Corte", "Barba"). */
  services: string[];
  /** Quiénes atendieron, sin repetir, en el orden de las líneas. */
  staffNames: string[];
}

/**
 * Cuántas ventas tiene el día (en SQL: la lista se corta en 200, el conteo no), con la regla del
 * historial (salesByDay.paid): las cobradas ese día que no se anularon ese mismo día. Una venta
 * anulada después sigue contando en su día; la anulación cuenta el día en que se aprobó.
 */
export async function paidSalesCount(db: Db, input: { locationId: bigint; businessDate: string }): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sales)
    .where(
      and(
        eq(sales.locationId, input.locationId),
        eq(sales.businessDate, input.businessDate),
        sql`not exists (select 1 from journal_entries e
                         where e.location_id = ${sales.locationId} and e.id = ${sales.voidEntryId} and e.business_date = ${sales.businessDate})`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Ventas de un día contable de la sede, de la más reciente a la más antigua. */
export async function salesOfDay(db: Db, input: { locationId: bigint; businessDate: string; limit?: number }): Promise<SaleListRow[]> {
  const rows = await db
    .select({
      id: sales.id,
      publicId: sales.publicId,
      createdAt: sales.createdAt,
      status: sales.status,
      totalPaid: sales.totalPaid,
      voidedOn: sql<string | null>`(select e.business_date::text from journal_entries e where e.location_id = ${sales.locationId} and e.id = ${sales.voidEntryId})`,
    })
    .from(sales)
    .where(and(eq(sales.locationId, input.locationId), eq(sales.businessDate, input.businessDate)))
    .orderBy(desc(sales.createdAt), desc(sales.id))
    .limit(input.limit ?? 200);
  if (rows.length === 0) return [];

  const lines = await db
    .select({ saleId: saleLines.saleId, description: saleLines.description, staffName: staffMembers.displayName })
    .from(saleLines)
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, saleLines.locationId), eq(staffMembers.id, saleLines.staffId)))
    .where(and(eq(saleLines.locationId, input.locationId), inArray(saleLines.saleId, rows.map((r) => r.id))))
    .orderBy(asc(saleLines.saleId), asc(saleLines.position));

  const bySale = new Map<bigint, { services: string[]; staffNames: string[] }>();
  for (const l of lines) {
    const entry = bySale.get(l.saleId) ?? { services: [], staffNames: [] };
    entry.services.push(l.description);
    if (!entry.staffNames.includes(l.staffName)) entry.staffNames.push(l.staffName);
    bySale.set(l.saleId, entry);
  }
  return rows.map((r) => ({
    publicId: r.publicId,
    createdAt: r.createdAt,
    status: r.status,
    voidedOn: r.voidedOn,
    totalPaid: r.totalPaid,
    services: bySale.get(r.id)?.services ?? [],
    staffNames: bySale.get(r.id)?.staffNames ?? [],
  }));
}

// ─── Envío del recibo al cliente ─────────────────────────────────────────────

const MAX_ITEMS_TEXT = 120;

/** "Corte, Barba y propina", recortado para que quepa en una variable de WhatsApp. */
function itemsText(services: string[], hasTips: boolean): string {
  const all = hasTips ? [...services, "propina"] : services;
  const text = all.length > 1 ? `${all.slice(0, -1).join(", ")} y ${all.at(-1)}` : (all[0] ?? "Venta");
  return [...text].length > MAX_ITEMS_TEXT ? `${[...text].slice(0, MAX_ITEMS_TEXT - 1).join("")}…` : text;
}

/**
 * Deja en el outbox el recibo de una venta para su cliente (lo entrega el worker, a lo sumo una
 * vez). WhatsApp si tiene celular y el canal existe; si no, correo. Devuelve el canal, o null si
 * la venta no tiene cliente, está anonimizado, no tiene cómo recibirlo o está anulada.
 * La clave `sale_receipt:<ULID>` hace que un reintento del cobro no lo duplique.
 * Sin cita no hay enlace: el mensaje lleva el resumen, no un link al panel.
 */
export async function enqueueSaleReceipt(
  db: Db,
  input: { locationId: bigint; publicId: string; channels: readonly NotificationChannel[]; hash: (value: string) => string },
): Promise<NotificationChannel | null> {
  const [row] = await db
    .select({
      appointmentId: sales.appointmentId,
      clientId: clients.id,
      clientName: clients.name,
      phoneE164: clients.phoneE164,
      email: clients.email,
      anonymizedAt: clients.anonymizedAt,
    })
    .from(sales)
    .innerJoin(clients, and(eq(clients.locationId, sales.locationId), eq(clients.id, sales.clientId)))
    .where(and(eq(sales.locationId, input.locationId), eq(sales.publicId, input.publicId)));
  if (!row || row.anonymizedAt) return null;
  const target = preferredChannel(row, input.channels);
  if (!target) return null;

  const receipt = await saleReceipt(db, { locationId: input.locationId, publicId: input.publicId });
  if (!receipt || receipt.status !== "paid") return null;
  const { dateLabel, timeLabel } = instantLabels(receipt.createdAt, receipt.location.timeZone);

  await enqueueNotification(db, {
    locationId: input.locationId,
    appointmentId: row.appointmentId,
    clientId: row.clientId,
    channel: target.channel,
    template: "sale_receipt",
    recipientHash: input.hash(target.to),
    dedupeKey: `sale_receipt:${input.publicId}`,
    params: {
      name: firstNameForMessage(row.clientName) || "cliente",
      number: saleNumber(input.publicId),
      date: `${dateLabel}, ${timeLabel}`,
      items: itemsText(
        receipt.lines.map((l) => l.description),
        receipt.tipLines.length > 0,
      ),
      total: format(money(receipt.totalPaid)),
      payment: [...new Set(receipt.payments.map((p) => p.label))].join(" y "),
    },
  });
  return target.channel;
}
