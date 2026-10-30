import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CashError } from "@/domain/sales/cash";
import { CheckoutError } from "@/domain/sales/checkout";
import { VoidError } from "@/domain/sales/void";
import { backoffMs, friendlyConstraintError, isRetryable, MAX_RETRIES, serializable } from "./serializable";
import type { Db } from "./types";

// serializable() sin base de datos (M3): una Db falsa que falla con los códigos de Postgres que
// queramos, para ver qué se repite, qué no, cuánto se espera y qué mensaje recibe la persona.

function pgErr(code: string, constraint?: string): Error {
  // Como lo entrega Drizzle: el error de Postgres va en `cause`.
  return Object.assign(new Error("Failed query"), { cause: Object.assign(new Error(`pg ${code}`), { code, constraint_name: constraint }) });
}

function fakeDb(failures: Error[]) {
  const calls: { isolationLevel?: string }[] = [];
  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>, opts: { isolationLevel?: string }) {
      calls.push(opts);
      const next = failures.shift();
      const result = await fn({});
      if (next) throw next;
      return result;
    },
  };
  return { db: db as unknown as Db, calls };
}

const noSleep = { sleep: async () => {} };

describe("serializable: reintentos", () => {
  it.each([
    ["40001 (conflicto de serialización)", pgErr("40001")],
    ["40P01 (interbloqueo)", pgErr("40P01")],
    ["23505 en una clave de idempotencia", pgErr("23505", "sales_idempotency_key")],
  ])("repite toda la función tras %s", async (_name, err) => {
    const { db, calls } = fakeDb([err]);
    let runs = 0;
    await expect(serializable(db, async () => ++runs, noSleep)).resolves.toBe(2);
    expect(runs).toBe(2);
    expect(calls).toEqual([{ isolationLevel: "serializable" }, { isolationLevel: "serializable" }]);
  });

  it("no repite otros errores (ni un 23505 que no es de idempotencia)", async () => {
    for (const err of [pgErr("23514", "sale_lines_commission_check"), pgErr("23505", "staff_members_pkey"), new Error("otra cosa")]) {
      const { db, calls } = fakeDb([err]);
      await expect(serializable(db, async () => 1, noSleep)).rejects.toBe(err);
      expect(calls).toHaveLength(1);
    }
  });

  it("se rinde después de MAX_RETRIES reintentos", async () => {
    const errs = Array.from({ length: MAX_RETRIES + 2 }, () => pgErr("40001"));
    const last = errs[MAX_RETRIES]!;
    const { db, calls } = fakeDb(errs);
    await expect(serializable(db, async () => 1, noSleep)).rejects.toBe(last);
    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it("espera entre intentos, cada vez un poco más", async () => {
    const waits: number[] = [];
    const { db } = fakeDb([pgErr("40001"), pgErr("40P01"), pgErr("40001")]);
    await serializable(db, async () => 1, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toHaveLength(3);
    waits.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(5 * (i + 1));
      expect(ms).toBeLessThanOrEqual(25 * (i + 1));
    });
  });

  it("acepta el número de reintentos como antes", async () => {
    const { db, calls } = fakeDb([pgErr("40001"), pgErr("40001")]);
    await expect(serializable(db, async () => 1, 1)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe("serializable: mensajes de una carrera (L4)", () => {
  it.each([
    ["cash_sessions_one_open", CashError, "La caja ya está abierta"],
    ["void_requests_one_pending", VoidError, "Ya hay una solicitud de anulación pendiente para esta venta"],
    ["sales_one_paid_per_appointment", CheckoutError, "Esta cita ya está cobrada"],
    ["journal_entries_reverses_entry_id_key", VoidError, "Esta venta ya está anulada"],
  ])("%s se traduce", async (constraint, Type, message) => {
    const { db } = fakeDb([pgErr("23505", constraint)]);
    const err = await serializable(db, async () => 1, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Type);
    expect((err as Error).message).toBe(message);
  });

  it("lo desconocido queda igual", () => {
    expect(friendlyConstraintError(pgErr("23505", "otra_cosa"))).toBeUndefined();
    expect(friendlyConstraintError(pgErr("23514", "cash_sessions_one_open"))).toBeUndefined();
    expect(friendlyConstraintError(new Error("x"))).toBeUndefined();
  });

  it("isRetryable lee el código aunque venga envuelto", () => {
    expect(isRetryable(pgErr("40001"))).toBe(true);
    expect(isRetryable(new Error("40001"))).toBe(false);
  });
});

describe("backoffMs: propiedades", () => {
  it("siempre entre 5 y 25 ms por intento, y crece con el intento", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (attempt, r) => {
        const ms = backoffMs(attempt, () => r);
        expect(ms).toBeGreaterThanOrEqual(5 * attempt);
        expect(ms).toBeLessThanOrEqual(25 * attempt);
        expect(backoffMs(attempt + 1, () => r)).toBeGreaterThanOrEqual(ms);
      }),
    );
  });
});
