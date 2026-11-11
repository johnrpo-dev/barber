import type { Metadata } from "next";
import { db } from "@/db/client";
import { inventoryBalance } from "@/db/inventory";
import { lastPurchases, listProducts } from "@/db/products";
import type { Db } from "@/db/types";
import { format, money, mulDiv } from "@/domain/money";
import { requirePermission } from "@/lib/session";
import { type ProductRow, ProductsManager } from "./products-manager";

export const metadata: Metadata = { title: "Productos · Villa" };

export default async function ProductosPage() {
  const staff = await requirePermission("inventory.manage");
  const conn = db() as unknown as Db;
  const [products, last, balance] = await Promise.all([
    listProducts(conn, { locationId: staff.locationId }),
    lastPurchases(conn, staff.locationId),
    inventoryBalance(conn, staff.locationId),
  ]);

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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <ProductsManager products={rows} inventoryLabel={format(money(balance))} />
    </main>
  );
}
