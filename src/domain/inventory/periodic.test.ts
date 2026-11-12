import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "../ledger/accounts";
import { assertValidEntry, type JournalEntryDraft, netByAccount } from "../ledger/entry";
import { fromUnits, money } from "../money";
import {
  countAdjustmentEntry,
  type CountedLine,
  expectedUnits,
  isLastDayOfMonth,
  type LastPurchase,
  type PurchaseLine,
  type PurchasePaidFrom,
  purchaseEntry,
  purchaseTotal,
  unitDifference,
  valueCount,
  valueCountLine,
} from "./periodic";
import { assertValidProduct } from "./product";

const META = { businessDate: "2026-11-30", memo: "Prueba" };
const net = (entries: readonly JournalEntryDraft[], code: string) => netByAccount(entries.flatMap((e) => e.lines)).get(code as never)?.minor ?? 0n;

describe("compra de mercancía", () => {
  it("entra a 1435 contra la caja, el banco o el capital del dueño (carga inicial)", () => {
    const lines: PurchaseLine[] = [
      { productId: 1n, quantity: 6, amount: fromUnits(60_000n) },
      { productId: 2n, quantity: 3, amount: fromUnits(45_000n) },
    ];
    const total = purchaseTotal(lines);
    expect(total).toEqual(fromUnits(105_000n));
    for (const [paidFrom, source] of [
      ["cash", ACCOUNTS.cash.code],
      ["bank", ACCOUNTS.bank.code],
      ["owner", ACCOUNTS.ownerEquity.code],
    ] as const) {
      const entry = purchaseEntry({ total, paidFrom }, META);
      assertValidEntry(entry);
      expect(entry.kind).toBe("inventory_purchase");
      expect(net([entry], ACCOUNTS.inventory.code)).toBe(total.minor);
      expect(net([entry], source)).toBe(-total.minor);
    }
  });

  it("rechaza compras vacías, repetidas, con centavos, unidades no enteras o total cero", () => {
    const line = (over: Partial<PurchaseLine> = {}): PurchaseLine => ({ productId: 1n, quantity: 1, amount: fromUnits(1_000n), ...over });
    expect(() => purchaseTotal([])).toThrow(/al menos un producto/);
    expect(() => purchaseTotal([line(), line()])).toThrow(/dos veces/);
    expect(() => purchaseTotal([line({ amount: money(150n) })])).toThrow(/pesos enteros/);
    expect(() => purchaseTotal([line({ amount: money(-100n) })])).toThrow(/negativo/);
    expect(() => purchaseTotal([line({ quantity: 0 })])).toThrow(/entre 1/);
    expect(() => purchaseTotal([line({ quantity: 1.5 })])).toThrow(/entero/);
    expect(() => purchaseTotal([line({ amount: money(0n) })])).toThrow(/mayor que cero/);
    // Una muestra gratis junto a algo pagado sí vale.
    expect(purchaseTotal([line(), line({ productId: 2n, amount: money(0n) })])).toEqual(fromUnits(1_000n));
  });
});

describe("valoración del conteo", () => {
  it("unidades × costo unitario de la última compra, half-up una vez por línea", () => {
    // Última compra: 7 unidades por $10.000. Contadas 3: 1.000.000 × 3 / 7 = 428.571,43 → 428.571 centavos.
    expect(valueCountLine(3, { quantity: 7, amount: fromUnits(10_000n) })).toEqual({ value: money(428_571n), costKnown: true });
    // Todas las unidades de la última compra valen exactamente lo que costó.
    expect(valueCountLine(7, { quantity: 7, amount: fromUnits(10_000n) }).value).toEqual(fromUnits(10_000n));
    expect(valueCountLine(0, { quantity: 7, amount: fromUnits(10_000n) }).value.minor).toBe(0n);
  });

  it("un producto sin compras vale 0 y queda marcado", () => {
    expect(valueCountLine(5, undefined)).toEqual({ value: money(0n), costKnown: false });
    const { lines, total } = valueCount([{ productId: 9n, quantity: 5 }], new Map());
    expect(lines[0]!.costKnown).toBe(false);
    expect(total.minor).toBe(0n);
  });

  it("rechaza unidades negativas o no enteras y productos repetidos", () => {
    expect(() => valueCountLine(-1, null)).toThrow(/entre 0/);
    expect(() => valueCountLine(2.5, null)).toThrow(/entero/);
    expect(() => valueCount([{ productId: 1n, quantity: 1 }, { productId: 1n, quantity: 2 }], new Map())).toThrow(/dos veces/);
  });

  it("PROPIEDAD: la valoración nunca crea ni pierde centavos respecto a la regla", () => {
    const last = fc.record({ quantity: fc.integer({ min: 1, max: 5_000 }), units: fc.bigInt({ min: 0n, max: 50_000_000n }) });
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 10_000 }), fc.option(last, { nil: undefined })), { maxLength: 30 }), (rows) => {
        const lastPurchases = new Map<bigint, LastPurchase>();
        const counted: CountedLine[] = rows.map(([quantity, lp], i) => {
          if (lp) lastPurchases.set(BigInt(i), { quantity: lp.quantity, amount: fromUnits(lp.units) });
          return { productId: BigInt(i), quantity };
        });
        const { lines, total } = valueCount(counted, lastPurchases);
        let acc = 0n;
        for (const l of lines) {
          const lp = lastPurchases.get(l.productId);
          acc += l.value.minor;
          expect(l.value.minor >= 0n).toBe(true);
          if (!lp) {
            expect(l).toMatchObject({ value: money(0n), costKnown: false });
            continue;
          }
          // value·d está a lo sumo a medio centavo·d de amount·q (un solo redondeo, half-up).
          const exact = lp.amount.minor * BigInt(l.quantity);
          const d = BigInt(lp.quantity);
          const diff = l.value.minor * d - exact;
          expect(2n * (diff < 0n ? -diff : diff) <= d).toBe(true);
          if (2n * diff === -d) throw new Error("un empate se redondeó hacia abajo");
          if (l.quantity === lp.quantity) expect(l.value).toEqual(lp.amount);
        }
        // El total es exactamente la suma de las líneas: no se redondea otra vez.
        expect(total.minor).toBe(acc);
      }),
    );
  });
});

describe("ajuste del conteo", () => {
  it("faltó valor: Dr 6135 / Cr 1435; sobró: Dr 1435 / Cr 6135; igual: sin asiento", () => {
    const loss = countAdjustmentEntry({ bookBalance: fromUnits(100_000n), countedValue: fromUnits(70_000n) }, META)!;
    assertValidEntry(loss);
    expect(loss.kind).toBe("inventory_count");
    expect(net([loss], ACCOUNTS.costOfGoodsSold.code)).toBe(fromUnits(30_000n).minor);
    expect(net([loss], ACCOUNTS.inventory.code)).toBe(-fromUnits(30_000n).minor);

    const gain = countAdjustmentEntry({ bookBalance: fromUnits(70_000n), countedValue: money(10_000_050n) }, META)!;
    assertValidEntry(gain);
    expect(net([gain], ACCOUNTS.inventory.code)).toBe(3_000_050n);
    expect(net([gain], ACCOUNTS.costOfGoodsSold.code)).toBe(-3_000_050n);

    expect(countAdjustmentEntry({ bookBalance: fromUnits(5_000n), countedValue: fromUnits(5_000n) }, META)).toBeNull();
    expect(() => countAdjustmentEntry({ bookBalance: money(0n), countedValue: money(-1n) }, META)).toThrow(/negativo/);
  });
});

// ─── Propiedades del ciclo completo: compras y conteos en cualquier orden ───

type Op =
  | { kind: "purchase"; paidFrom: PurchasePaidFrom; lines: { product: number; quantity: number; units: bigint }[] }
  | { kind: "count"; quantities: number[] };

const PRODUCTS = 4;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("purchase" as const),
    paidFrom: fc.constantFrom<PurchasePaidFrom>("cash", "bank", "owner"),
    lines: fc.uniqueArray(
      fc.record({ product: fc.integer({ min: 0, max: PRODUCTS - 1 }), quantity: fc.integer({ min: 1, max: 60 }), units: fc.bigInt({ min: 1n, max: 400_000n }) }),
      { minLength: 1, maxLength: PRODUCTS, selector: (l) => l.product },
    ),
  }),
  fc.record({ kind: fc.constant("count" as const), quantities: fc.array(fc.integer({ min: 0, max: 80 }), { minLength: PRODUCTS, maxLength: PRODUCTS }) }),
);

interface Snapshot {
  /** Valor del inventario contado (0 al empezar). */
  inventory: bigint;
  purchases: bigint;
  cogs: bigint;
}

/** Corre las operaciones como lo haría la base: cada asiento al libro, el saldo de 1435 sumado del libro. */
function simulate(ops: readonly Op[]) {
  const entries: JournalEntryDraft[] = [];
  const last = new Map<bigint, LastPurchase>();
  let purchases = 0n;
  const snapshots: Snapshot[] = [{ inventory: 0n, purchases: 0n, cogs: 0n }];
  const afterCount: { book: bigint; counted: bigint }[] = [];
  for (const op of ops) {
    if (op.kind === "purchase") {
      const lines: PurchaseLine[] = op.lines.map((l) => ({ productId: BigInt(l.product), quantity: l.quantity, amount: fromUnits(l.units) }));
      const total = purchaseTotal(lines);
      entries.push(purchaseEntry({ total, paidFrom: op.paidFrom }, META));
      for (const l of lines) last.set(l.productId, { quantity: l.quantity, amount: l.amount });
      purchases += total.minor;
    } else {
      const { total } = valueCount(
        op.quantities.map((quantity, i) => ({ productId: BigInt(i), quantity })),
        last,
      );
      const entry = countAdjustmentEntry({ bookBalance: money(net(entries, ACCOUNTS.inventory.code)), countedValue: total }, META);
      if (entry) entries.push(entry);
      afterCount.push({ book: net(entries, ACCOUNTS.inventory.code), counted: total.minor });
      snapshots.push({ inventory: total.minor, purchases, cogs: net(entries, ACCOUNTS.costOfGoodsSold.code) });
    }
  }
  return { entries, afterCount, snapshots };
}

describe("PROPIEDADES del inventario periódico", () => {
  it("después de cualquier conteo, el saldo de 1435 es exactamente el valor contado", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        const { afterCount } = simulate(ops);
        for (const c of afterCount) expect(c.book).toBe(c.counted);
      }),
    );
  });

  it("6135 del periodo entre dos conteos = inventario inicial + compras − inventario final", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        const { snapshots } = simulate(ops);
        for (let i = 0; i < snapshots.length; i++) {
          for (let j = i + 1; j < snapshots.length; j++) {
            const a = snapshots[i]!;
            const b = snapshots[j]!;
            expect(b.cogs - a.cogs).toBe(a.inventory + (b.purchases - a.purchases) - b.inventory);
          }
        }
      }),
    );
  });

  it("todo asiento cuadra, es de inventario y solo toca las cuentas de su tipo", () => {
    const allowed: Record<string, readonly string[]> = {
      inventory_purchase: [ACCOUNTS.inventory.code, ACCOUNTS.cash.code, ACCOUNTS.bank.code, ACCOUNTS.ownerEquity.code],
      inventory_count: [ACCOUNTS.inventory.code, ACCOUNTS.costOfGoodsSold.code],
    };
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        const { entries } = simulate(ops);
        for (const e of entries) {
          assertValidEntry(e);
          for (const l of e.lines) expect(allowed[e.kind]).toContain(l.account);
        }
        // El balance de prueba de todo lo simulado da cero.
        const totals = [...netByAccount(entries.flatMap((e) => e.lines)).values()].reduce((s, m) => s + m.minor, 0n);
        expect(totals).toBe(0n);
      }),
    );
  });
});

describe("unidades esperadas contra contadas", () => {
  it("ejemplo: 10 contadas + 5 compradas − 2 vendidas = 13; se cuentan 12 → falta 1", () => {
    const m = { base: 10, purchased: 5, sold: 2 };
    expect(expectedUnits(m)).toBe(13);
    expect(unitDifference(12, m)).toBe(-1);
    // Vendido sin compra registrada: el esperado negativo se muestra tal cual.
    expect(expectedUnits({ base: 0, purchased: 0, sold: 3 })).toBe(-3);
  });

  it("propiedad: esperado + diferencia = contado, y encadenar periodos es lo mismo que sumarlos", () => {
    const mv = fc.record({ base: fc.integer({ min: 0, max: 100_000 }), purchased: fc.integer({ min: 0, max: 100_000 }), sold: fc.integer({ min: -500, max: 100_000 }) });
    fc.assert(
      fc.property(mv, fc.integer({ min: 0, max: 100_000 }), (m, counted) => {
        expect(expectedUnits(m) + unitDifference(counted, m)).toBe(counted);
        expect(unitDifference(expectedUnits(m), m)).toBe(0);
      }),
    );
    // Sin conteo en medio, dos periodos seguidos esperan lo mismo que uno con sus compras y ventas sumadas.
    fc.assert(
      fc.property(mv, fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (a, p2, s2) => {
        const chained = expectedUnits({ base: expectedUnits(a), purchased: p2, sold: s2 });
        expect(chained).toBe(expectedUnits({ base: a.base, purchased: a.purchased + p2, sold: a.sold + s2 }));
      }),
    );
  });
});

describe("día del conteo", () => {
  it("el último día de cada mes, con febrero bisiesto", () => {
    expect(isLastDayOfMonth("2026-11-30")).toBe(true);
    expect(isLastDayOfMonth("2026-11-29")).toBe(false);
    expect(isLastDayOfMonth("2026-12-31")).toBe(true);
    expect(isLastDayOfMonth("2027-02-28")).toBe(true);
    expect(isLastDayOfMonth("2028-02-28")).toBe(false);
    expect(isLastDayOfMonth("2028-02-29")).toBe(true);
    expect(() => isLastDayOfMonth("30/11/2026")).toThrow();
  });

  it("propiedad: exactamente un día por mes, y el siguiente es el 1.º", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), fc.integer({ min: 1, max: 12 }), (year, month) => {
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const ymd = (d: number) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const last = Array.from({ length: days }, (_, i) => i + 1).filter((d) => isLastDayOfMonth(ymd(d)));
        expect(last).toEqual([days]);
      }),
    );
  });
});

describe("producto del catálogo", () => {
  it("nombre de 2 a 80, referencia opcional, precio en pesos enteros y comisión de 0 a 100 %", () => {
    const ok = { name: "Cera mate", sku: null, price: fromUnits(35_000n), commissionBps: 1_000 };
    expect(() => assertValidProduct(ok)).not.toThrow();
    expect(() => assertValidProduct({ ...ok, name: " x " })).toThrow(/nombre/);
    expect(() => assertValidProduct({ ...ok, sku: "x".repeat(41) })).toThrow(/referencia/);
    expect(() => assertValidProduct({ ...ok, price: money(3_500_050n) })).toThrow(/pesos enteros/);
    expect(() => assertValidProduct({ ...ok, commissionBps: 10_001 })).toThrow(/comisión/);
    expect(() => assertValidProduct({ ...ok, commissionBps: 0.5 })).toThrow(/comisión/);
  });
});
