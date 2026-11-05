import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { locations, saleLines, salePayments, sales, saleTips, staffMembers } from "./schema";
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
  totalPaid: bigint;
  /** Descripciones de las líneas en orden ("Corte", "Barba"). */
  services: string[];
  /** Quiénes atendieron, sin repetir, en el orden de las líneas. */
  staffNames: string[];
}

/** Ventas de un día contable de la sede, de la más reciente a la más antigua. */
export async function salesOfDay(db: Db, input: { locationId: bigint; businessDate: string; limit?: number }): Promise<SaleListRow[]> {
  const rows = await db
    .select({ id: sales.id, publicId: sales.publicId, createdAt: sales.createdAt, status: sales.status, totalPaid: sales.totalPaid })
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
    totalPaid: r.totalPaid,
    services: bySale.get(r.id)?.services ?? [],
    staffNames: bySale.get(r.id)?.staffNames ?? [],
  }));
}
