import type { Metadata } from "next";
import { db } from "@/db/client";
import { countDueToday, countReport, countSheet, inventoryBalance, PURCHASE_LOCK_MESSAGES, recentCounts, recentPurchases } from "@/db/inventory";
import { PAID_FROM_LABELS } from "@/domain/inventory/periodic";
import { dayLabel } from "../_components/dates";
import { lastPurchases, listProducts } from "@/db/products";
import type { Db } from "@/db/types";
import { format, money, mulDiv, negate } from "@/domain/money";
import { requirePermission } from "@/lib/session";
import type { CountHistoryRow, CountSheetData } from "./count-form";
import { type ProductRow, ProductsManager, type PurchaseRow } from "./products-manager";

export const metadata: Metadata = { title: "Productos · Villa" };

export default async function ProductosPage() {
  const staff = await requirePermission("inventory.manage");
  const conn = db() as unknown as Db;
  const [products, last, balance, purchases, sheet, counts, countDue] = await Promise.all([
    listProducts(conn, { locationId: staff.locationId }),
    lastPurchases(conn, staff.locationId),
    inventoryBalance(conn, staff.locationId),
    recentPurchases(conn, staff.locationId),
    countSheet(conn, staff.locationId),
    recentCounts(conn, staff.locationId),
    countDueToday(conn, staff.locationId),
  ]);
  // Las diferencias de los últimos conteos se arman aquí (pocas filas): la hoja solo las muestra.
  const reports = await Promise.all(counts.map((c) => countReport(conn, staff.locationId, c.id)));

  const purchaseRows: PurchaseRow[] = purchases.map((p) => ({
    id: p.id.toString(),
    dateLabel: dayLabel(p.businessDate),
    paidFrom: p.paidFrom,
    paidFromLabel: PAID_FROM_LABELS[p.paidFrom],
    totalLabel: format(p.total),
    summary: p.summary,
    note: p.note,
    reversed: p.lock === "reversed",
    // Por qué ya no se puede anular (se muestra en lugar del botón), o null si se puede.
    lockMessage: p.lock && p.lock !== "reversed" ? PURCHASE_LOCK_MESSAGES[p.lock] : null,
  }));

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
      />
    </main>
  );
}
