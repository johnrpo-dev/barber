import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromUnits } from "@/domain/money";
import { CashError } from "@/domain/sales/cash";
import { addExpense } from "./expenses";
import { key, setupShop } from "./sales-testing";
import { expenses } from "./schema";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// El permiso de gasto de banco (expenses.bank, solo el dueño) se exige también en la base, no solo
// en la server action: cualquier otro camino que llame a addExpense queda cubierto.

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("gasto de banco", () => {
  it("recepción no lo registra aunque llegue directo a la base; el dueño sí", async () => {
    const shop = await setupShop(db, "Gastos");
    const base = { locationId: shop.locationId, categoryId: shop.category, amount: fromUnits(500_000n), paidFrom: "bank" as const, description: "Arriendo" };
    for (const role of ["reception", "barber"] as const) {
      await expect(addExpense(db, { ...base, idempotencyKey: key(), actor: { userId: `u-${role}`, role } })).rejects.toThrow(CashError);
    }
    expect(await db.select().from(expenses).where(eq(expenses.locationId, shop.locationId))).toEqual([]);
    await expect(addExpense(db, { ...base, idempotencyKey: key(), actor: shop.owner })).resolves.toMatchObject({ created: true });
  });
});
