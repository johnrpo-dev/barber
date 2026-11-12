import type { Metadata } from "next";
import { db } from "@/db/client";
import { countDueToday, countReport, countSheet, inventoryBalance, PURCHASE_LOCK_MESSAGES, recentCounts, recentPurchases } from "@/db/inventory";
import { PAYMENT_LOCK_MESSAGES, payables, supplierNames } from "@/db/payables";
import { SUPPLIER_PAID_FROM_LABELS } from "@/domain/inventory/payables";
import { PAID_FROM_LABELS } from "@/domain/inventory/periodic";
import { dayLabel } from "../_components/dates";
import { lastPurchases, listProducts } from "@/db/products";
import type { Db } from "@/db/types";
import { format, money, mulDiv, negate, PESO } from "@/domain/money";
import { requirePermission } from "@/lib/session";
import type { CountHistoryRow, CountSheetData } from "./count-form";
import type { PayablesData } from "./payables-section";
import { type ProductRow, ProductsManager, type PurchaseRow } from "./products-manager";

export const metadata: Metadata = { title: "Productos · Villa" };

export default async function ProductosPage() {
  const staff = await requirePermission("inventory.manage");
  const conn = db() as unknown as Db;
  const [products, last, balance, purchases, sheet, counts, countDue, owed, suppliers] = await Promise.all([
    listProducts(conn, { locationId: staff.locationId }),
    lastPurchases(conn, staff.locationId),
    inventoryBalance(conn, staff.locationId),
    recentPurchases(conn, staff.locationId),
    countSheet(conn, staff.locationId),
    recentCounts(conn, staff.locationId),
    countDueToday(conn, staff.locationId),
    payables(conn, staff.locationId),
    supplierNames(conn, staff.locationId),
  ]);
  // Las diferencias de los últimos conteos se arman aquí (pocas filas): la hoja solo las muestra.
  const reports = await Promise.all(counts.map((c) => countReport(conn, staff.locationId, c.id)));

  const purchaseRows: PurchaseRow[] = purchases.map((p) => ({
    id: p.id.toString(),
    dateLabel: dayLabel(p.businessDate),
    paidFrom: p.paidFrom,
    paidFromLabel: p.supplierName ? `a crédito con ${p.supplierName}` : PAID_FROM_LABELS[p.paidFrom],
    totalLabel: format(p.total),
    summary: p.summary,
    note: p.note,
    reversed: p.lock === "reversed",
    // Por qué ya no se puede anular (se muestra en lugar del botón), o null si se puede.
    lockMessage: p.lock && p.lock !== "reversed" ? PURCHASE_LOCK_MESSAGES[p.lock] : null,
  }));

  // Cuentas por pagar (sprint 8, parte A). Los saldos los suma la base; aquí solo se formatean. Los
  // montos de las compras son pesos enteros (lo exige la base), así que minor / PESO es exacto.
  const payablesData: PayablesData = {
    balanceLabel: format(owed.balance),
    pendingCount: owed.rows.filter((r) => r.outstanding.minor > 0n).length,
    rows: owed.rows.map((r) => ({
      documentId: r.documentId.toString(),
      supplierName: r.supplierName,
      summary: r.summary,
      dateLabel: dayLabel(r.businessDate),
      dueDateLabel: dayLabel(r.dueDate),
      dueLabel: r.due.label,
      dueState: r.due.state,
      totalLabel: format(r.total),
      paidLabel: r.paid.minor > 0n ? format(r.paid) : null,
      outstandingMinor: r.outstanding.minor.toString(),
      outstandingUnits: (r.outstanding.minor / PESO).toString(),
      outstandingLabel: format(r.outstanding),
      payments: r.payments.map((p) => ({
        id: p.id.toString(),
        dateLabel: dayLabel(p.businessDate),
        amountLabel: format(p.amount),
        paidFrom: p.paidFrom,
        paidFromLabel: SUPPLIER_PAID_FROM_LABELS[p.paidFrom],
        reversed: p.lock === "reversed",
        lockMessage: p.lock === "session_closed" ? PAYMENT_LOCK_MESSAGES.session_closed : null,
      })),
    })),
  };

  // bigint no viaja como JSON: ids y montos van como texto; las etiquetas se formatean aquí para que
  // servidor y navegador no difieran al hidratar.
  const rows: ProductRow[] = products.map((p) => {
    const lp = last.get(p.id);
    return {
      id: p.id.toString(),
      name: p.name,
      sku: p.sku,
      priceMinor: p.price.minor.toString(),
      priceLabel: format(p.price),
      commissionBps: p.commissionBps,
      active: p.active,
      // Costo unitario de la última compra (el que valora el conteo), redondeado una vez con mulDiv.
      unitCostLabel: lp && lp.quantity > 0 ? format(mulDiv(lp.amount, 1n, BigInt(lp.quantity))) : null,
    };
  });

  const countSheetData: CountSheetData = {
    products: sheet.rows.map((r) => {
      const lp = last.get(r.productId);
      return {
        id: r.productId.toString(),
        name: r.name,
        active: r.active,
        base: r.base,
        purchased: r.purchased,
        sold: r.sold,
        costMinor: lp ? lp.amount.minor.toString() : null,
        costQuantity: lp ? lp.quantity : null,
      };
    }),
    bookMinor: balance.toString(),
    lastCountLabel: sheet.lastCount ? dayLabel(sheet.lastCount.businessDate) : null,
  };

  const countRows: CountHistoryRow[] = reports.flatMap((r) =>
    r
      ? [
          {
            id: r.count.id.toString(),
            dateLabel: dayLabel(r.count.businessDate),
            totalLabel: format(r.count.total),
            adjustmentLabel: format(r.count.adjustment.minor < 0n ? negate(r.count.adjustment) : r.count.adjustment),
            adjustment: r.count.adjustment.minor > 0n ? "cost" : r.count.adjustment.minor < 0n ? "surplus" : "none",
            previousLabel: r.previous ? dayLabel(r.previous.businessDate) : null,
            missingUnits: r.rows.reduce((s, x) => s + (x.difference < 0 ? -x.difference : 0), 0),
            rows: r.rows.map((x) => ({
              name: x.name,
              base: x.base,
              purchased: x.purchased,
              sold: x.sold,
              expected: x.expected,
              counted: x.counted,
              difference: x.difference,
              valueLabel: format(x.value),
            })),
          } satisfies CountHistoryRow,
        ]
      : [],
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <ProductsManager
        products={rows}
        purchases={purchaseRows}
        inventoryLabel={format(money(balance))}
        countSheet={countSheetData}
        counts={countRows}
        countDue={countDue}
        payables={payablesData}
        suppliers={suppliers}
        today={owed.today}
      />
    </main>
  );
}
