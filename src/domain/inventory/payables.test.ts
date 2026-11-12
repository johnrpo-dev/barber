import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "../ledger/accounts";
import { assertValidEntry, type JournalEntryDraft, netByAccount } from "../ledger/entry";
import { fromUnits, money, PESO } from "../money";
import {
  assertPayment,
  cleanSupplierName,
  daysBetween,
  dueDateFor,
  dueStatus,
  MAX_TERM_DAYS,
  outstanding,
  SUPPLIER_PAID_FROM,
  type SupplierPaidFrom,
  supplierPaymentEntry,
} from "./payables";
import { purchaseEntry } from "./periodic";

const META = { businessDate: "2026-11-30", memo: "Prueba" };
const net = (entries: readonly JournalEntryDraft[], code: string) => netByAccount(entries.flatMap((e) => e.lines)).get(code as never)?.minor ?? 0n;

describe("compra a crédito y pago al proveedor", () => {
  it("la compra a crédito sube 1435 contra 2205; el pago baja 2205 contra la caja, el banco o el dueño", () => {
    const buy = purchaseEntry({ total: fromUnits(300_000n), paidFrom: "credit" }, META);
    assertValidEntry(buy);
    expect(net([buy], ACCOUNTS.inventory.code)).toBe(30_000_000n);
    expect(net([buy], ACCOUNTS.accountsPayable.code)).toBe(-30_000_000n);

    const sources: Record<SupplierPaidFrom, string> = { cash: "1105", bank: "1110", owner: "3105" };
    for (const paidFrom of SUPPLIER_PAID_FROM) {
      const pay = supplierPaymentEntry({ amount: fromUnits(100_000n), paidFrom }, META);
      assertValidEntry(pay);
      expect(pay.kind).toBe("supplier_payment");
      expect(net([pay], ACCOUNTS.accountsPayable.code)).toBe(10_000_000n);
      expect(net([pay], sources[paidFrom])).toBe(-10_000_000n);
      expect(pay.lines).toHaveLength(2);
    }
  });

  it("un pago de cero no arma asiento", () => {
    expect(() => supplierPaymentEntry({ amount: money(0n), paidFrom: "cash" }, META)).toThrow(/mayor que cero/);
  });

  it("el saldo es total − pagos y un pago no supera lo que se debe", () => {
    const owed = outstanding(fromUnits(300_000n), fromUnits(120_000n));
    expect(owed.minor).toBe(18_000_000n);
    expect(() => assertPayment(fromUnits(180_000n), owed)).not.toThrow();
    expect(() => assertPayment(fromUnits(180_001n), owed)).toThrow(/mayor que lo que se debe/);
    expect(() => assertPayment(fromUnits(0n), owed)).toThrow(/mayor que cero/);
    expect(() => assertPayment(money(150n), owed)).toThrow(/pesos enteros/);
    expect(() => assertPayment(fromUnits(1n), money(0n))).toThrow(/ya está pagada/);
    expect(() => outstanding(fromUnits(1n), fromUnits(2n))).toThrow(/superan/);
  });

  it("propiedad: con pagos válidos en cualquier orden, 2205 de la compra queda en lo que falta y nunca negativo", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 5_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 5_000_000n }), { maxLength: 12 }),
        fc.array(fc.constantFrom(...SUPPLIER_PAID_FROM), { minLength: 12, maxLength: 12 }),
        (totalUnits, attempts, sources) => {
          const total = fromUnits(totalUnits);
          const entries: JournalEntryDraft[] = [purchaseEntry({ total, paidFrom: "credit" }, META)];
          let paid = 0n;
          attempts.forEach((units, i) => {
            const amount = fromUnits(units);
            const owed = outstanding(total, money(paid));
            const ok = amount.minor <= owed.minor && owed.minor > 0n;
            if (!ok) {
              expect(() => assertPayment(amount, owed)).toThrow();
              return;
            }
            assertPayment(amount, owed);
            entries.push(supplierPaymentEntry({ amount, paidFrom: sources[i]! }, META));
            paid += amount.minor;
          });
          for (const e of entries) assertValidEntry(e);
          // Lo que se le debe al proveedor según el libro es exactamente lo que falta por pagar.
          expect(-net(entries, ACCOUNTS.accountsPayable.code)).toBe(total.minor - paid);
          expect(total.minor - paid).toBeGreaterThanOrEqual(0n);
          // 1435 solo la subió la compra: pagar no cambia el inventario.
          expect(net(entries, ACCOUNTS.inventory.code)).toBe(total.minor);
          expect(paid % PESO).toBe(0n);
        },
      ),
    );
  });
});

describe("vencimiento", () => {
  it("suma el plazo en días de calendario, cruzando meses y años", () => {
    expect(dueDateFor("2026-11-12", 30)).toBe("2026-12-12");
    expect(dueDateFor("2026-12-20", 15)).toBe("2027-01-04");
    expect(dueDateFor("2028-02-28", 1)).toBe("2028-02-29");
    expect(dueDateFor("2026-11-12", 0)).toBe("2026-11-12");
    expect(() => dueDateFor("2026-11-12", MAX_TERM_DAYS + 1)).toThrow(/plazo/);
    expect(() => dueDateFor("2026-11-12", -1)).toThrow(/plazo/);
    expect(() => dueDateFor("2026-11-12", 1.5)).toThrow(/plazo/);
    expect(() => dueDateFor("2026-02-30", 1)).toThrow(/Fecha/);
  });

  it("dice si está vencida, vence hoy, por vencer o más adelante", () => {
    expect(dueStatus("2026-11-10", "2026-11-12")).toEqual({ state: "overdue", days: -2, label: "Vencida hace 2 días" });
    expect(dueStatus("2026-11-11", "2026-11-12").label).toBe("Vencida hace 1 día");
    expect(dueStatus("2026-11-12", "2026-11-12")).toEqual({ state: "today", days: 0, label: "Vence hoy" });
    expect(dueStatus("2026-11-13", "2026-11-12")).toEqual({ state: "soon", days: 1, label: "Vence en 1 día" });
    expect(dueStatus("2026-11-15", "2026-11-12").state).toBe("soon");
    expect(dueStatus("2026-11-16", "2026-11-12")).toEqual({ state: "later", days: 4, label: "Vence en 4 días" });
  });

  it("propiedad: el vencimiento queda exactamente a `plazo` días y su estado es coherente", () => {
    const day = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, fc.integer({ min: 0, max: MAX_TERM_DAYS }), fc.integer({ min: -400, max: 400 }), (bought, term, offset) => {
        const due = dueDateFor(bought, term);
        expect(daysBetween(bought, due)).toBe(term);
        expect(due >= bought).toBe(true);
        const today = new Date(Date.parse(`${bought}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
        const status = dueStatus(due, today);
        expect(status.days).toBe(term - offset);
        expect(status.state === "overdue").toBe(status.days < 0);
        expect(status.state === "today").toBe(status.days === 0);
      }),
    );
  });
});

describe("nombre del proveedor", () => {
  it("se limpia y se valida", () => {
    expect(cleanSupplierName("  Distribuidora   El Barbero ")).toBe("Distribuidora El Barbero");
    expect(() => cleanSupplierName("x")).toThrow(/entre 2 y 80/);
    expect(() => cleanSupplierName("a".repeat(81))).toThrow(/entre 2 y 80/);
    expect(() => cleanSupplierName("Prov\u0007eedor")).toThrow(/no permitidos/);
    // C1, invisibles de formato y saltos de línea: no pasan (la base no los aceptaría o partirían al proveedor).
    expect(() => cleanSupplierName("Prov\u0085eedor")).toThrow(/no permitidos/);
    expect(() => cleanSupplierName("Prov​eedor")).toThrow(/no permitidos/);
    expect(() => cleanSupplierName("Prov\needor")).toThrow(/no permitidos/);
    // La tilde aparte y la letra acentuada son el mismo nombre.
    expect(cleanSupplierName("José Pérez")).toBe("José Pérez");
  });
});
