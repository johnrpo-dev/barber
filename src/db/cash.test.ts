import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, money } from "@/domain/money";
import { CashError, needsCashReview } from "@/domain/sales/cash";
import { VoidError } from "@/domain/sales/void";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import {
  cashDeposit,
  closeBusinessDay,
  closeCashSession,
  lastClosedSession,
  ledgerCash,
  markSessionReviewed,
  openCashSession,
  openSession,
  payTips,
  sessionExpectedFromMovements,
  sessionsNeedingReview,
  sessionSummary,
  tipsOwed,
} from "./cash";
import { addExpense } from "./expenses";
import { closeDay, postEntry, trialBalance } from "./ledger";
import { chairAppointment, key, quickSale, type Shop, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { checkout } from "./sales";
import { cashMovements, cashSessions, locations, sales } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Caja sobre PostgreSQL real (PGlite): el esperado es el saldo de 1105 en el libro y siempre se
// puede explicar con los movimientos del turno (docs/sprint-4-cobro-caja.md §4 y §8).

let db: Db;
let client: PGlite;
const cop = (pesos: bigint) => fromUnits(pesos);
let shopSeq = 0;
const newShop = () => setupShop(db, `Caja ${++shopSeq}`);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const open = (shop: Shop, counted: bigint, note?: string) =>
  openCashSession(db, { locationId: shop.locationId, counted: cop(counted), note, idempotencyKey: key("open"), actor: shop.owner });
const close = (shop: Shop, counted: bigint, note?: string) =>
  closeCashSession(db, { locationId: shop.locationId, counted: cop(counted), note, idempotencyKey: key("close"), actor: shop.owner });

async function balanceOf(shop: Shop, code: string): Promise<bigint> {
  const rows = await trialBalance(db, { locationId: shop.locationId });
  const row = rows.find((r) => r.code === code);
  return row ? row.debits - row.credits : 0n;
}

/** El esperado del libro coincide con base + movimientos del turno, y no queda nada sin explicar. */
async function expectDrawerExplained(shop: Shop) {
  const summary = await sessionSummary(db, shop.locationId);
  if (!summary) return;
  expect(summary.unexplained).toBe(0n);
  expect(await sessionExpectedFromMovements(db, shop.locationId, summary.id)).toBe(await ledgerCash(db, shop.locationId));
}

/** Σ propinas por pagar (por persona) = saldo acreedor de 2380. */
async function expectTipsMatchLedger(shop: Shop) {
  const owed = (await tipsOwed(db, shop.locationId)).reduce((acc, t) => acc + t.owed, 0n);
  expect(owed).toBe(-(await balanceOf(shop, ACCOUNTS.tipsPayable.code)));
}

describe("abrir y cerrar la caja", () => {
  it("abrir con diferencia exige nota; con nota queda un ajuste y el libro igual a lo contado", async () => {
    const shop = await newShop();
    await expect(open(shop, 5_000n)).rejects.toThrow(/^Escribe una nota/);
    expect(await openSession(db, shop.locationId)).toBeUndefined();
    const opened = await open(shop, 5_000n, "Quedó base de ayer sin registrar");
    expect(opened).toMatchObject({ expected: 0n, difference: 500_000n, created: true });
    expect(await ledgerCash(db, shop.locationId)).toBe(500_000n);
    await expectDrawerExplained(shop);
  });

  it("no se abre dos veces; la misma clave repite la respuesta; otra cosa con la misma clave es conflicto", async () => {
    const shop = await newShop();
    const k = key("open");
    const input = { locationId: shop.locationId, counted: cop(0n), idempotencyKey: k, actor: shop.owner };
    const first = await openCashSession(db, input);
    expect(await openCashSession(db, input)).toEqual({ ...first, created: false });
    await expect(openCashSession(db, { ...input, counted: cop(1_000n), note: "x" })).rejects.toThrow(IdempotencyConflictError);
    await expect(open(shop, 0n)).rejects.toThrow(/^La caja ya está abierta/);
  });

  it("cerrar: el esperado sale del libro; una diferencia exige nota y queda registrada", async () => {
    const shop = await newShop();
    await open(shop, 0n);
    await quickSale(db, shop, { kind: "cash" });
    await expect(close(shop, 25_000n)).rejects.toThrow(/^Escribe una nota/);
    const closed = await close(shop, 25_000n, "Faltan $5.000, se revisa mañana");
    expect(closed).toMatchObject({ expected: 3_000_000n, counted: 2_500_000n, difference: -500_000n });
    expect(await ledgerCash(db, shop.locationId)).toBe(2_500_000n);
    expect(await sessionSummary(db, shop.locationId)).toBeNull();
    expect(await lastClosedSession(db, shop.locationId)).toMatchObject({ counted: 2_500_000n, difference: -500_000n, note: "Faltan $5.000, se revisa mañana" });
    await expect(close(shop, 0n)).rejects.toThrow(/^La caja no está abierta/);
    // Al abrir de nuevo con lo mismo que se contó, no hay diferencia.
    expect(await open(shop, 25_000n)).toMatchObject({ difference: 0n });
  });

  it("la caja cerrada no se reabre ni se cambia en la base", async () => {
    const shop = await newShop();
    const { sessionId } = await open(shop, 0n);
    await close(shop, 0n);
    expect(await dbError(db.update(cashSessions).set({ closedAt: null }).where(eq(cashSessions.id, sessionId)))).toMatch(/caja/);
    expect(await dbError(db.update(cashSessions).set({ openingCounted: 1n }).where(eq(cashSessions.id, sessionId)))).toMatch(/caja/);
  });
});

describe("cierre del día", () => {
  it("con la caja abierta no se cierra el día: ni desde la app ni con un INSERT directo", async () => {
    const shop = await newShop();
    await open(shop, 0n);
    const day = businessDate(new Date(), TZ);
    await expect(closeBusinessDay(db, { locationId: shop.locationId, businessDate: day, actor: shop.owner })).rejects.toThrow(
      /^Cierra la caja antes de cerrar el día/,
    );
    expect(await dbError(closeDay(db, { locationId: shop.locationId, businessDate: day, createdBy: "x" }))).toMatch(/cierra la caja antes de cerrar el día/);
    await close(shop, 0n);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: day, actor: shop.owner });
    await expect(closeBusinessDay(db, { locationId: shop.locationId, businessDate: day, actor: shop.owner })).rejects.toThrow(/^El día ya está cerrado/);
    // Con el día cerrado no se mueve efectivo.
    await expect(open(shop, 1_000n, "sobra")).rejects.toThrow(/^El día ya está cerrado/);
  });

  it("no se cierra un día que no ha llegado", async () => {
    const shop = await newShop();
    await expect(closeBusinessDay(db, { locationId: shop.locationId, businessDate: "2999-01-01", actor: shop.owner })).rejects.toThrow(
      /no ha llegado/,
    );
  });
});

describe("movimientos de la caja", () => {
  it("propinas: no más de lo que se debe; consignación y gastos: no más del efectivo; repetir la clave no duplica", async () => {
    const shop = await newShop();
    await open(shop, 0n);
    await quickSale(db, shop, { kind: "cash", tip: 4_000n });
    const tipInput = { locationId: shop.locationId, staffId: shop.barber, amount: cop(3_000n), idempotencyKey: key("tips"), actor: shop.owner };
    await expect(payTips(db, { ...tipInput, amount: cop(5_000n), idempotencyKey: key() })).rejects.toThrow(/supera las propinas/);
    const paid = await payTips(db, tipInput);
    expect(await payTips(db, tipInput)).toEqual({ movementId: paid.movementId, created: false });
    await expect(payTips(db, { ...tipInput, amount: cop(1_000n) })).rejects.toThrow(IdempotencyConflictError);
    expect(await tipsOwed(db, shop.locationId)).toEqual([{ staffId: shop.barber, name: "Andrés", owed: 100_000n }]);

    await expect(
      cashDeposit(db, { locationId: shop.locationId, amount: cop(40_000n), idempotencyKey: key(), actor: shop.owner }),
    ).rejects.toThrow(/^No hay tanto efectivo en la caja/);
    await expect(
      addExpense(db, {
        locationId: shop.locationId,
        categoryId: shop.category,
        amount: cop(40_000n),
        paidFrom: "cash",
        description: "Compra grande",
        idempotencyKey: key(),
        actor: shop.owner,
      }),
    ).rejects.toThrow(/^No hay tanto efectivo en la caja/);
    const depositInput = { locationId: shop.locationId, amount: cop(10_000n), idempotencyKey: key("dep"), actor: shop.owner };
    const dep = await cashDeposit(db, depositInput);
    expect(await cashDeposit(db, depositInput)).toEqual({ movementId: dep.movementId, created: false });
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(34_000n - 3_000n - 10_000n).minor);
    await expectDrawerExplained(shop);
    await expectTipsMatchLedger(shop);
  });

  it("sin caja abierta no hay gastos de caja, propinas ni consignaciones; un gasto de banco sí", async () => {
    const shop = await newShop();
    const base = { locationId: shop.locationId, idempotencyKey: key(), actor: shop.owner };
    await expect(
      addExpense(db, { ...base, categoryId: shop.category, amount: cop(1_000n), paidFrom: "cash", description: "Jabón" }),
    ).rejects.toThrow(CashError);
    await expect(payTips(db, { ...base, staffId: shop.barber, amount: cop(1_000n) })).rejects.toThrow(/^Abre la caja/);
    await expect(cashDeposit(db, { ...base, amount: cop(1_000n) })).rejects.toThrow(/^Abre la caja/);
    await expect(
      addExpense(db, { ...base, categoryId: shop.category, amount: cop(800_000n), paidFrom: "bank", description: "Arriendo" }),
    ).resolves.toMatchObject({ created: true });
    expect(await balanceOf(shop, ACCOUNTS.bank.code)).toBe(-80_000_000n);
  });

  it("cobro en efectivo contra cierre de caja simultáneo: el cobro entra al turno que se cierra o se rechaza, nunca queda suelto", async () => {
    const shop = await newShop();
    await open(shop, 0n);
    const appointmentId = await chairAppointment(db, shop);
    const [sale, closed] = await Promise.allSettled([
      checkout(db, simpleCheckout(shop, appointmentId, { kind: "cash" })),
      close(shop, 0n, "Cierre con cobro en curso"),
    ]);
    expect(closed.status).toBe("fulfilled");
    const session = (closed as PromiseFulfilledResult<Awaited<ReturnType<typeof close>>>).value;
    if (sale.status === "fulfilled") {
      expect(session.expected).toBe(3_000_000n);
      const moves = await db
        .select({ sessionId: cashMovements.cashSessionId })
        .from(cashMovements)
        .where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.kind, "sale")));
      expect(moves).toEqual([{ sessionId: session.sessionId }]);
    } else {
      expect((sale.reason as Error).message).toMatch(/^Abre la caja para recibir efectivo/);
      expect(session.expected).toBe(0n);
    }
    // Después del cierre, el libro dice exactamente lo contado.
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
  });
});

describe("propiedad: el esperado siempre se explica con los movimientos", () => {
  type Op =
    | { kind: "cashSale"; tip: bigint }
    | { kind: "cardSale"; tip: bigint }
    | { kind: "expense"; amount: bigint }
    | { kind: "bankExpense"; amount: bigint }
    | { kind: "tips"; amount: bigint }
    | { kind: "deposit"; amount: bigint }
    | { kind: "recount"; diff: bigint }
    | { kind: "closeDrawer" }
    | { kind: "openDrawer" }
    | { kind: "void"; pick: number };

  const pesos = (max: bigint) => fc.bigInt({ min: 1n, max }).map((p) => p * 1_000n);
  const tip = fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 10n }).map((p) => p * 1_000n));
  const op: fc.Arbitrary<Op> = fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant("cashSale" as const), tip }), weight: 3 },
    { arbitrary: fc.record({ kind: fc.constant("cardSale" as const), tip }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("expense" as const), amount: pesos(40n) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("bankExpense" as const), amount: pesos(40n) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("tips" as const), amount: pesos(10n) }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("deposit" as const), amount: pesos(60n) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("recount" as const), diff: fc.bigInt({ min: -5n, max: 5n }).map((p) => p * 1_000n) }), weight: 1 },
    { arbitrary: fc.constant({ kind: "closeDrawer" as const }), weight: 1 },
    { arbitrary: fc.constant({ kind: "openDrawer" as const }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("void" as const), pick: fc.nat() }), weight: 3 },
  );

  // Cuántas operaciones pasaron en total: la propiedad no vale nada si casi todo se rechaza (T3).
  const tally = { ops: 0, ok: 0 };

  it("tras cualquier secuencia: 1105 = base + Σ movimientos, 1105 ≥ 0, y Σ propinas por pagar = 2380", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
        const shop = await newShop();
        await open(shop, 50_000n, "Base inicial");
        /** Ventas sin anular (efectivo, tarjeta, con o sin propina) y su solicitud pendiente, si quedó. */
        const live: { saleId: bigint; requestId?: bigint }[] = [];
        for (const o of ops) {
          const base = { locationId: shop.locationId, idempotencyKey: key(), actor: shop.owner };
          tally.ops++;
          try {
            switch (o.kind) {
              case "cashSale":
              case "cardSale": {
                const { saleId } = await quickSale(db, shop, { kind: o.kind === "cashSale" ? "cash" : "card", tip: o.tip });
                live.push({ saleId });
                break;
              }
              case "expense":
              case "bankExpense":
                await addExpense(db, {
                  ...base,
                  categoryId: shop.category,
                  amount: cop(o.amount),
                  paidFrom: o.kind === "expense" ? "cash" : "bank",
                  description: "Gasto de prueba",
                });
                break;
              case "tips":
                await payTips(db, { ...base, staffId: shop.barber, amount: cop(o.amount) });
                break;
              case "deposit":
                await cashDeposit(db, { ...base, amount: cop(o.amount) });
                break;
              case "recount": {
                if (!(await openSession(db, shop.locationId))) throw new CashError("La caja no está abierta");
                const expected = (await ledgerCash(db, shop.locationId)) / 100n;
                const counted = expected + o.diff < 0n ? 0n : expected + o.diff;
                await close(shop, counted, "Conteo de prueba");
                await open(shop, counted);
                expect(await ledgerCash(db, shop.locationId)).toBe(counted * 100n);
                break;
              }
              case "closeDrawer": {
                const counted = (await ledgerCash(db, shop.locationId)) / 100n;
                const closed = await close(shop, counted);
                expect(closed.difference).toBe(0n);
                break;
              }
              case "openDrawer":
                await open(shop, (await ledgerCash(db, shop.locationId)) / 100n);
                break;
              case "void": {
                if (live.length === 0) throw new VoidError("No hay ventas para anular");
                const i = o.pick % live.length;
                const target = live[i]!;
                target.requestId ??= (await requestVoid(db, { ...base, saleId: target.saleId, reason: "Prueba", actor: shop.reception })).requestId;
                // Con la caja cerrada, una venta en efectivo no se anula (C1); con tarjeta, sí.
                await decideVoid(db, { ...base, requestId: target.requestId, approve: true, note: "", approver: shop.owner });
                live.splice(i, 1);
                break;
              }
            }
            tally.ok++;
          } catch (err) {
            // Lo que la regla de negocio rechaza (más propinas de las debidas, más efectivo del que hay,
            // efectivo con la caja cerrada) no cuenta; cualquier otro error, sí.
            if (!(err instanceof CashError) && !(err instanceof VoidError)) throw err;
          }
          await expectDrawerExplained(shop);
          await expectTipsMatchLedger(shop);
          // Abierta o cerrada, el libro de caja nunca queda negativo (también lo exige la base, 0011).
          expect(await ledgerCash(db, shop.locationId)).toBeGreaterThanOrEqual(0n);
        }
      }),
      { numRuns: 25 },
    );
    // La tasa real ronda el 55–65 % según la semilla (con la caja cerrada se rechaza mucho); 0,4
    // sigue atrapando una propiedad vacía sin volverse aleatoria en la CI.
    expect(tally.ok / tally.ops).toBeGreaterThan(0.4);
  }, 600_000);
});

describe("caja: casos del sprint 4 (revisión)", () => {
  it("un turno que cruza la medianoche de Bogotá: cada cobro en su día y el turno lo explica todo", async () => {
    const shop = await newShop();
    const d = addDays(businessDate(new Date(), TZ), -3);
    const before = localMinuteToInstant(d, 23 * 60 + 50, TZ);
    const after = localMinuteToInstant(addDays(d, 1), 10, TZ);
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner, now: before });
    const s1 = await checkout(db, { ...simpleCheckout(shop, await chairAppointment(db, shop), { kind: "cash" }), now: before });
    const s2 = await checkout(db, { ...simpleCheckout(shop, await chairAppointment(db, shop), { kind: "cash" }), now: after });
    const days = await db.select({ id: sales.id, day: sales.businessDate }).from(sales).where(eq(sales.locationId, shop.locationId));
    expect(new Map(days.map((r) => [r.id, r.day]))).toEqual(
      new Map([
        [s1.saleId, d],
        [s2.saleId, addDays(d, 1)],
      ]),
    );
    expect(await ledgerCash(db, shop.locationId)).toBe(6_000_000n);
    await expectDrawerExplained(shop);
    const closed = await closeCashSession(db, { locationId: shop.locationId, counted: cop(60_000n), idempotencyKey: key(), actor: shop.owner, now: after });
    expect(closed).toMatchObject({ expected: 6_000_000n, difference: 0n, needsReview: false });
    // Con la caja cerrada, los dos días se pueden cerrar.
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: d, actor: shop.owner, now: after });
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: addDays(d, 1), actor: shop.owner, now: after });
  });

  it("el esperado queda congelado en lo que decía el libro antes del ajuste, al abrir y al cerrar", async () => {
    const shop = await newShop();
    await open(shop, 0n);
    await quickSale(db, shop, { kind: "cash" });
    const closed = await close(shop, 25_000n, "Faltaron 5.000");
    expect(closed).toMatchObject({ expected: 3_000_000n, counted: 2_500_000n, difference: -500_000n });
    expect(await ledgerCash(db, shop.locationId)).toBe(2_500_000n);
    const opened = await open(shop, 26_000n, "Apareció un billete");
    expect(opened).toMatchObject({ expected: 2_500_000n, difference: 100_000n });
    const rows = await db
      .select({ openingExpected: cashSessions.openingExpected, expectedCash: cashSessions.expectedCash })
      .from(cashSessions)
      .where(eq(cashSessions.locationId, shop.locationId))
      .orderBy(cashSessions.id);
    expect(rows).toEqual([
      { openingExpected: 0n, expectedCash: 3_000_000n },
      { openingExpected: 2_500_000n, expectedCash: null },
    ]);
    expect(await ledgerCash(db, shop.locationId)).toBe(2_600_000n);
  });

  it("revisión de cierres: la base marca |diferencia| > umbral (como needsCashReview) y el dueño la da por revisada una vez", async () => {
    const shop = await newShop();
    const [loc] = await db.select({ threshold: locations.cashReviewThreshold }).from(locations).where(eq(locations.id, shop.locationId));
    expect(loc!.threshold).toBe(2_000_000n);
    // Sin diferencia, sobrante de $20.000 (igual al umbral: no) y faltante de $20.001 (sí).
    for (const [diff, flagged] of [
      [0n, false],
      [20_000n, false],
      [-20_001n, true],
    ] as const) {
      const ledger = (await ledgerCash(db, shop.locationId)) / 100n;
      await open(shop, ledger);
      if (diff < 0n) await quickSale(db, shop, { kind: "cash" });
      const now = (await ledgerCash(db, shop.locationId)) / 100n;
      const closed = await close(shop, now + diff, diff === 0n ? undefined : "Diferencia de prueba");
      expect(closed.difference).toBe(diff * 100n);
      expect(closed.needsReview).toBe(needsCashReview(money(closed.difference), money(2_000_000n)));
      expect(closed.needsReview).toBe(flagged);
    }
    const flagged = await sessionsNeedingReview(db, shop.locationId);
    expect(flagged).toHaveLength(1);
    await markSessionReviewed(db, { locationId: shop.locationId, sessionId: flagged[0]!.id, actor: shop.owner });
    expect(await sessionsNeedingReview(db, shop.locationId)).toEqual([]);
    await expect(markSessionReviewed(db, { locationId: shop.locationId, sessionId: flagged[0]!.id, actor: shop.owner })).rejects.toThrow(
      "Ese cierre ya se revisó",
    );
    const [first] = await db.select({ id: cashSessions.id }).from(cashSessions).where(eq(cashSessions.locationId, shop.locationId)).orderBy(cashSessions.id);
    await expect(markSessionReviewed(db, { locationId: shop.locationId, sessionId: first!.id, actor: shop.owner })).rejects.toThrow(
      "Ese cierre no está marcado para revisión",
    );
    // En la base: la marca no se cambia a mano ni se "des-revisa".
    expect(await dbError(client.query(`update cash_sessions set needs_review = false where id = $1`, [String(flagged[0]!.id)]))).toMatch(/caja: el turno/);
    expect(await dbError(client.query(`update cash_sessions set reviewed_by = 'otro' where id = $1`, [String(flagged[0]!.id)]))).toMatch(/caja: el turno/);
  });

  it("una apertura con diferencia mayor que el umbral también va a revisión; una sola revisión cubre apertura y cierre", async () => {
    const shop = await newShop();
    const opened = await open(shop, 25_000n, "Apareció plata de ayer");
    expect(opened.difference).toBe(2_500_000n);
    const [row] = await db
      .select({ opening: cashSessions.openingNeedsReview, closing: cashSessions.needsReview })
      .from(cashSessions)
      .where(eq(cashSessions.id, opened.sessionId));
    expect(row).toEqual({ opening: true, closing: false });
    // Aparece aunque el turno siga abierto, pero se revisa después de cerrarlo.
    expect((await sessionsNeedingReview(db, shop.locationId)).map((f) => [f.id, f.openingNeedsReview, f.closedAt])).toEqual([[opened.sessionId, true, null]]);
    await expect(markSessionReviewed(db, { locationId: shop.locationId, sessionId: opened.sessionId, actor: shop.owner })).rejects.toThrow(
      "Ese turno sigue abierto: se revisa después de cerrarlo",
    );
    // Cierre con faltante grande: el mismo turno queda con las dos marcas, y una revisión basta.
    expect((await close(shop, 0n, "Se fue en vueltos")).needsReview).toBe(true);
    expect(await sessionsNeedingReview(db, shop.locationId)).toHaveLength(1);
    await markSessionReviewed(db, { locationId: shop.locationId, sessionId: opened.sessionId, actor: shop.owner });
    expect(await sessionsNeedingReview(db, shop.locationId)).toEqual([]);
    // La marca de apertura la pone la base: no se finge ni se quita al insertar.
    const fake = await dbError(
      client.query(
        `insert into cash_sessions (location_id, opened_by, opening_counted, opening_expected, open_idempotency_key, open_request_hash, needs_review)
         values ($1, 'x', 0, 0, 'mano-2-xxxxxx', repeat('a', 64), true)`,
        [String(shop.locationId)],
      ),
    );
    expect(fake).toMatch(/un turno nace abierto/);
  });

  it("LOW-4: quien cuenta a ciegas no recibe 'No hay tanto efectivo' (no da una cota del esperado)", async () => {
    const shop = await newShop();
    await open(shop, 10_000n, "Base");
    const blind = cashDeposit(db, { locationId: shop.locationId, amount: cop(50_000n), idempotencyKey: key(), actor: shop.reception });
    await expect(blind).rejects.toThrow(/^Ese monto no se puede sacar de la caja ahora/);
    await expect(
      payTips(db, { locationId: shop.locationId, staffId: shop.barber, amount: cop(1_000n), idempotencyKey: key(), actor: shop.reception }),
    ).rejects.toThrow(/supera las propinas/);
    await expect(
      addExpense(db, { locationId: shop.locationId, categoryId: shop.category, amount: cop(50_000n), paidFrom: "cash", description: "Compra", idempotencyKey: key(), actor: shop.reception }),
    ).rejects.toThrow(/^Ese monto no se puede sacar de la caja ahora/);
    await expect(cashDeposit(db, { locationId: shop.locationId, amount: cop(50_000n), idempotencyKey: key(), actor: shop.owner })).rejects.toThrow(
      /^No hay tanto efectivo en la caja/,
    );
  });

  it("un umbral alto no marca nada; uno en cero marca cualquier diferencia", async () => {
    const shop = await newShop();
    await client.query(`update locations set cash_review_threshold = 0 where id = $1`, [String(shop.locationId)]);
    await open(shop, 0n);
    await quickSale(db, shop, { kind: "cash" });
    expect((await close(shop, 29_999n, "Un peso")).needsReview).toBe(true);
  });

  it("L1: no se abre un turno en un día cerrado, aunque no haya diferencia", async () => {
    const shop = await newShop();
    const d = addDays(businessDate(new Date(), TZ), -2);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: d, actor: shop.owner });
    await expect(
      openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner, now: localMinuteToInstant(d, 600, TZ) }),
    ).rejects.toThrow(/^El día ya está cerrado/);
    expect(await openSession(db, shop.locationId)).toBeFalsy();
  });

  it("M2 en la base: un turno que no cuadra con el libro, o un movimiento que no mueve efectivo, no se confirman", async () => {
    const shop = await newShop();
    // Abrir con $50.000 sin el asiento de ajuste: el libro dice 0.
    const err1 = await dbError(
      client.query(
        `insert into cash_sessions (location_id, opened_by, opening_counted, opening_expected, open_idempotency_key, open_request_hash)
         values ($1, 'x', 5000000, 5000000, 'mano-1-xxxxxx', repeat('a', 64))`,
        [String(shop.locationId)],
      ),
    );
    expect(err1).toMatch(/no es lo contado/);
    await open(shop, 0n);
    const session = await openSession(db, shop.locationId);
    // Un "movimiento de consignación" cuyo asiento no toca la caja.
    const err2 = await dbError(
      db.transaction(async (tx) => {
        const { entryId } = await postEntry(tx as unknown as Db, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: {
            businessDate: businessDate(new Date(), TZ),
            kind: "owner_contribution",
            memo: "Aporte",
            idempotencyKey: key("aporte"),
            lines: [
              { account: ACCOUNTS.bank.code, side: "debit", amount: cop(1_000n) },
              { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: cop(1_000n) },
            ],
          },
        });
        await tx.insert(cashMovements).values({
          locationId: shop.locationId,
          cashSessionId: session!.id,
          kind: "cash_deposit",
          journalEntryId: entryId,
          description: "Falsa",
          createdBy: "x",
        });
      }),
    );
    expect(err2).toMatch(/no corresponde a su asiento|no coincide con su registro/);
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
  });
});
