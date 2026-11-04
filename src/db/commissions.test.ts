import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { addDays } from "@/domain/booking/clock";
import { fromUnits, money as fromMinor } from "@/domain/money";
import { assemblePnl } from "@/domain/reports/pnl";
import { CashError } from "@/domain/sales/cash";
import { CheckoutError } from "@/domain/sales/checkout";
import { VoidError } from "@/domain/sales/void";
import { SettlementError, type AdjustmentInput, type PaidFrom } from "@/domain/commissions/settlement";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { closeBusinessDay, closeCashSession, ledgerCash, openCashSession, payTips, sessionExpectedFromMovements, sessionSummary, tipsOwed, reopenBusinessDay } from "./cash";
import {
  commissionBalances,
  giveAdvance,
  previewSettlement,
  receiptByPublicId,
  reverseAdvance,
  reverseSettlement,
  settleCommissions,
  type SettlementOptions,
  staffCommissionDetail,
} from "./commissions";
import { addExpense } from "./expenses";
import { postEntry, reverseEntry, trialBalance } from "./ledger";
import {
  cardFees,
  cashDifferences,
  dashboardData,
  expensesByCategory,
  journalDetail,
  noShowStats,
  paymentMix,
  profitAndLoss,
  salesByService,
  salesByStaff,
  settlementsInPeriod,
  tipsByStaff,
} from "./reports";
import { key, quickSale, type Shop, setupShop, TZ } from "./sales-testing";
import { auditEvents, cashMovements, commissionSettlementLines, commissionSettlements, staffAdvances } from "./schema";import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { ulid } from "./ulid";
import { decideVoid, requestVoid } from "./voids";

// Comisiones sobre PostgreSQL real (PGlite): liquidaciones, anticipos, reversas e informes
// (docs/sprint-5-comisiones-informes.md §11). Los saldos siempre deben cuadrar con el libro.

let db: Db;
let client: PGlite;
const cop = (pesos: bigint) => fromUnits(pesos);
let shopSeq = 0;
const newShop = () => setupShop(db, `Comisiones ${++shopSeq}`);
const today = () => businessDate(new Date(), TZ);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const options = (shop: Shop, over: Partial<SettlementOptions> = {}): SettlementOptions => ({
  locationId: shop.locationId,
  staffId: shop.barber,
  cutoffDate: today(),
  includeTips: true,
  advanceDeduction: "max",
  adjustments: [] as AdjustmentInput[],
  paidFrom: "bank" as PaidFrom,
  note: null,
  ...over,
});

async function settle(shop: Shop, over: Partial<SettlementOptions> = {}, idempotencyKey = key("settle")) {
  const preview = await previewSettlement(db, options(shop, over));
  return settleCommissions(db, { ...options(shop, over), previewToken: preview.previewToken, idempotencyKey, actor: shop.owner });
}

const open = (shop: Shop, counted: bigint) =>
  openCashSession(db, { locationId: shop.locationId, counted: cop(counted), note: "Base inicial", idempotencyKey: key("open"), actor: shop.owner });
const advance = (shop: Shop, pesos: bigint, paidFrom: PaidFrom = "bank", staffId = shop.barber) =>
  giveAdvance(db, { locationId: shop.locationId, staffId, amount: cop(pesos), paidFrom, reason: "Adelanto de quincena", idempotencyKey: key("adv"), actor: shop.owner });
const undoSettlement = (shop: Shop, publicId: string) =>
  reverseSettlement(db, { locationId: shop.locationId, publicId, reason: "Se liquidó de más", idempotencyKey: key("undo"), actor: shop.owner });
const undoAdvance = (shop: Shop, publicId: string) =>
  reverseAdvance(db, { locationId: shop.locationId, publicId, reason: "No se entregó", idempotencyKey: key("undo"), actor: shop.owner });

async function voidSale(shop: Shop, saleId: bigint) {
  const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
  return decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("decide"), approver: shop.owner });
}

async function balanceOf(shop: Shop, code: string): Promise<bigint> {
  const rows = await trialBalance(db, { locationId: shop.locationId });
  const row = rows.find((r) => r.code === code);
  return row ? row.debits - row.credits : 0n;
}

async function balance(shop: Shop, staffId = shop.barber) {
  const [row] = await commissionBalances(db, shop.locationId, { staffId });
  return row!;
}

const auditCount = async (shop: Shop, action: string) =>
  (await db.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, action)))).length;

/** Las invariantes de §11, después de cada paso. */
async function expectAllCoherent(shop: Shop) {
  const balances = await commissionBalances(db, shop.locationId);
  const total = (f: (b: (typeof balances)[number]) => bigint) => balances.reduce((acc, b) => acc + f(b), 0n);
  expect(total((b) => b.commissionOwed)).toBe(-(await balanceOf(shop, ACCOUNTS.commissionsPayable.code)));
  expect(total((b) => b.tipsOwed)).toBe(-(await balanceOf(shop, ACCOUNTS.tipsPayable.code)));
  expect(total((b) => b.receivable)).toBe(await balanceOf(shop, ACCOUNTS.staffReceivable.code));
  for (const b of balances) expect(b.receivable).toBeGreaterThanOrEqual(0n);

  // Σ (C − V) vigente + lo que se debe = Σ comisión congelada de las líneas en ventas pagadas.
  const { rows: perStaff } = await client.query<{ staff_id: string; settled: string; frozen: string }>(
    `select m.id::text as staff_id,
            coalesce((select sum(s.commission_total - s.clawback_total) from commission_settlements s
                       where s.location_id = m.location_id and s.staff_id = m.id and s.status = 'settled'), 0)::text as settled,
            coalesce((select sum(l.commission) from sale_lines l join sales v on v.id = l.sale_id
                       where l.location_id = m.location_id and l.staff_id = m.id and v.status = 'paid'), 0)::text as frozen
       from staff_members m where m.location_id = $1`,
    [String(shop.locationId)],
  );
  for (const row of perStaff) {
    const owed = balances.find((b) => b.staffId === BigInt(row.staff_id))!.commissionOwed;
    expect(BigInt(row.settled) + owed).toBe(BigInt(row.frozen));
  }

  const { rows: claims } = await client.query<{ n: string }>(
    `select count(*)::text as n from (
       select sale_line_id, kind from commission_settlement_lines
        where location_id = $1 and kind in ('commission', 'clawback') and not reversed
        group by sale_line_id, kind having count(*) > 1) x`,
    [String(shop.locationId)],
  );
  expect(claims[0]!.n).toBe("0");

  // Todo asiento cuadra y el balance total también.
  const { rows: unbalanced } = await client.query<{ n: string }>(
    `select count(*)::text as n from (
       select entry_id from journal_lines where location_id = $1 group by entry_id having sum(debit) <> sum(credit)) x`,
    [String(shop.locationId)],
  );
  expect(unbalanced[0]!.n).toBe("0");
  const trial = await trialBalance(db, { locationId: shop.locationId });
  expect(trial.reduce((acc, r) => acc + r.debits - r.credits, 0n)).toBe(0n);

  // Los informes contra el balance del mismo rango.
  const q = { locationId: shop.locationId, from: today(), to: today() };
  const { rows, totals } = await profitAndLoss(db, q);
  const pnl = assemblePnl(rows, totals);
  const inRange = await trialBalance(db, { locationId: shop.locationId, from: q.from, to: q.to });
  const typeNet = (type: string) => inRange.filter((r) => r.type === type).reduce((acc, r) => acc + r.credits - r.debits, 0n);
  expect(pnl.profit.minor).toBe(typeNet("income") + typeNet("expense"));
  const byStaff = await salesByStaff(db, q);
  const income4170 = inRange.find((r) => r.code === ACCOUNTS.serviceIncome.code);
  expect(byStaff.reduce((acc, r) => acc + r.net, 0n)).toBe(income4170 ? income4170.credits - income4170.debits : 0n);

  expect(await ledgerCash(db, shop.locationId)).toBeGreaterThanOrEqual(0n);
  const summary = await sessionSummary(db, shop.locationId);
  if (summary) {
    expect(summary.unexplained).toBe(0n);
    expect(await sessionExpectedFromMovements(db, shop.locationId, summary.id)).toBe(await ledgerCash(db, shop.locationId));
  }
}

describe("liquidar", () => {
  it("ejemplo completo: paga comisiones y propinas, descuenta el anticipo, y el asiento y el comprobante cuadran", async () => {
    const shop = await newShop();
    await quickSale(db, shop, { kind: "card", tip: 2_000n });
    await quickSale(db, shop, { kind: "card" });
    await advance(shop, 5_000n);
    const preview = await previewSettlement(db, options(shop, { adjustments: [{ direction: "add", amount: cop(1_000n), reason: "Bono de puntualidad" }] }));
    expect(preview.draft.commissionTotal.minor).toBe(cop(24_000n).minor);
    expect(preview.tipsOwed).toBeGreaterThan(0n);
    expect(preview.draft.tips.minor % 100n).toBe(0n);
    expect(preview.receivable).toBe(cop(5_000n).minor);
    expect(preview.draft.advanceDeduction.minor).toBe(cop(5_000n).minor);
    expect(preview.draft.payout.minor).toBe(preview.draft.commissionTotal.minor + preview.draft.tips.minor + cop(1_000n).minor - cop(5_000n).minor);

    const done = await settle(shop, { adjustments: [{ direction: "add", amount: cop(1_000n), reason: "Bono de puntualidad" }], note: "Quincena" });
    expect(done).toMatchObject({ created: true, number: 1n, payout: preview.draft.payout.minor });
    expect((await balance(shop)).commissionOwed).toBe(0n);
    expect((await balance(shop)).receivable).toBe(0n);
    await expectAllCoherent(shop);

    const receipt = await receiptByPublicId(db, { locationId: shop.locationId, publicId: done.publicId });
    expect(receipt).toMatchObject({ kind: "settlement", status: "settled", staffId: shop.barber, staffName: "Andrés", note: "Quincena", payout: done.payout });
    if (receipt?.kind !== "settlement") throw new Error("no es liquidación");
    expect(receipt.commissions).toHaveLength(2);
    expect(receipt.adjustments).toEqual([{ amount: cop(1_000n).minor, reason: "Bono de puntualidad" }]);
    expect(await auditCount(shop, "settlement.create")).toBe(1);
  });

  it("sin nada pendiente no hay liquidación", async () => {
    const shop = await newShop();
    await expect(previewSettlement(db, options(shop))).rejects.toThrow(/^No hay nada que liquidar/);
  });

  it("el corte: no futuro, no anterior al último, y las ventas posteriores al corte no entran", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    await expect(previewSettlement(db, options(shop, { cutoffDate: addDays(today(), 1) }))).rejects.toThrow(/^La fecha de corte no puede ser futura/);
    await expect(previewSettlement(db, options(shop, { cutoffDate: addDays(today(), -1) }))).rejects.toThrow(/^No hay nada que liquidar/);
    await settle(shop);
    await quickSale(db, shop);
    await expect(previewSettlement(db, options(shop, { cutoffDate: addDays(today(), -1) }))).rejects.toThrow(/^La fecha de corte no puede ser anterior/);
  });

  it("doble toque: la misma clave da una sola liquidación; misma clave con otro contenido, conflicto", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const opts = options(shop);
    const { previewToken } = await previewSettlement(db, opts);
    const cmd = { ...opts, previewToken, idempotencyKey: key("same"), actor: shop.owner };
    const first = await settleCommissions(db, cmd);
    const second = await settleCommissions(db, cmd);
    expect(second).toEqual({ ...first, created: false });
    expect(await auditCount(shop, "settlement.create")).toBe(1);
    await expect(settleCommissions(db, { ...cmd, note: "Otra cosa" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  // PGlite tiene una sola conexión: estas dos corren en serie. El cruce de verdad está en concurrency.pg.test.ts.
  it("dos liquidaciones seguidas con la misma vista previa y claves distintas: una sola paga cada línea", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const opts = options(shop);
    const { previewToken } = await previewSettlement(db, opts);
    const results = await Promise.allSettled(
      [key("a"), key("b")].map((idempotencyKey) => settleCommissions(db, { ...opts, previewToken, idempotencyKey, actor: shop.owner })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await balance(shop)).commissionOwed).toBe(0n);
    await expectAllCoherent(shop);
  });

  it("liquidación y anulación de una de sus ventas, seguidas con la misma vista previa: el resultado es coherente", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    await quickSale(db, shop);
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
    const opts = options(shop);
    const { previewToken } = await previewSettlement(db, opts);
    await Promise.allSettled([
      settleCommissions(db, { ...opts, previewToken, idempotencyKey: key("race"), actor: shop.owner }),
      decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("decide"), approver: shop.owner }),
    ]);
    // Entre las dos, o la línea anulada nunca se pagó, o se descuenta en la siguiente.
    const after = await balance(shop);
    expect(after.commissionOwed).toBe(after.pendingCommission - after.clawbacks);
    await expectAllCoherent(shop);
  });

  it("un cobro o una anulación después de la vista previa: 'La liquidación cambió'", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    const opts = options(shop);
    const { previewToken } = await previewSettlement(db, opts);
    await quickSale(db, shop);
    const cmd = () => ({ ...opts, previewToken, idempotencyKey: key(), actor: shop.owner });
    await expect(settleCommissions(db, cmd())).rejects.toThrow(/^La liquidación cambió/);

    const refreshed = await previewSettlement(db, opts);
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Error", idempotencyKey: key("void"), actor: shop.reception });
    await expect(settleCommissions(db, { ...cmd(), previewToken: refreshed.previewToken })).rejects.toThrow(/^La liquidación cambió/);
    // La línea con anulación pendiente queda fuera y se avisa cuántas esperan.
    expect((await previewSettlement(db, opts)).waitingVoidDecision).toBe(1);
    await expectAllCoherent(shop);
  });

  it("pago de caja: exige turno abierto y que el efectivo alcance; y deja su movimiento", async () => {
    const shop = await newShop();
    await quickSale(db, shop, { kind: "card" });
    await expect(settle(shop, { paidFrom: "cash" })).rejects.toThrow(/^Abre la caja para pagar en efectivo/);
    await open(shop, 5_000n);
    await expect(settle(shop, { paidFrom: "cash" })).rejects.toThrow(/^No hay tanto efectivo en la caja/);
    expect((await previewSettlement(db, options(shop, { paidFrom: "cash" }))).cash).toEqual({ sessionOpen: true, enough: false });
    await quickSale(db, shop, { kind: "cash" });
    const done = await settle(shop, { paidFrom: "cash" });
    expect(done.payout).toBe(cop(24_000n).minor);
    const [movement] = await db.select().from(cashMovements).where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.kind, "commission_payout")));
    expect(movement).toMatchObject({ staffId: shop.barber, description: "Liquidación N.º 0001 a Andrés" });
    await expectAllCoherent(shop);

    await undoSettlement(shop, done.publicId);
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(35_000n).minor);
    await expectAllCoherent(shop);
  });

  it("en un día cerrado no se liquida", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });
    await expect(settle(shop)).rejects.toThrow(/^El día ya está cerrado/);
    await expect(advance(shop, 1_000n)).rejects.toThrow(/^El día ya está cerrado/);
  });

  it("un pago de $0 no pide caja abierta ni mueve efectivo", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    await advance(shop, 12_000n);
    const done = await settle(shop, { paidFrom: "cash" });
    expect(done.payout).toBe(0n);
    const [row] = await db.select().from(commissionSettlements).where(eq(commissionSettlements.id, done.settlementId));
    expect(row!.paidFrom).toBeNull();
    await expectAllCoherent(shop);
  });

  it("si lo que se debe supera lo pendiente: nada se paga y lo que falta queda como arrastre", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop, { adjustments: [{ direction: "deduct", amount: cop(15_000n), reason: "Uniforme perdido" }] });
    expect(done.payout).toBe(0n);
    const [row] = await db.select().from(commissionSettlements).where(eq(commissionSettlements.id, done.settlementId));
    expect(row!.carryOver).toBe(cop(3_000n).minor);
    expect((await balance(shop)).receivable).toBe(cop(3_000n).minor);
    await expectAllCoherent(shop);
    // Una reversa de la liquidación deshace también el arrastre.
    await undoSettlement(shop, done.publicId);
    expect((await balance(shop)).receivable).toBe(0n);
    await expectAllCoherent(shop);
  });

  it("descontar más de lo posible se rechaza", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    await advance(shop, 3_000n);
    await expect(previewSettlement(db, options(shop, { advanceDeduction: cop(5_000n) }))).rejects.toThrow(/^El descuento de anticipos supera/);
  });
});

describe("reversas", () => {
  it("M-1: un anticipo ya tenido en cuenta por una liquidación no se revierte; la última liquidación sigue reversible", async () => {
    const shop = await newShop();
    const first = await advance(shop, 10_000n);
    const { saleId } = await quickSale(db, shop);
    const m = await settle(shop);
    expect(m.payout).toBe(cop(2_000n).minor); // $12.000 de comisión menos el anticipo de $10.000
    await voidSale(shop, saleId);
    const n = await settle(shop);
    expect((await balance(shop)).receivable).toBe(cop(12_000n).minor); // arrastra lo que ya se le pagó
    const later = await advance(shop, 5_000n);

    await expect(undoAdvance(shop, first.publicId)).rejects.toThrow(/revierte esa liquidación primero/);
    await expectAllCoherent(shop);
    // El anticipo posterior a la última liquidación sí se revierte, y esa liquidación también.
    await undoAdvance(shop, later.publicId);
    await undoSettlement(shop, n.publicId);
    await expectAllCoherent(shop);
    await undoSettlement(shop, m.publicId);
    // Sin liquidaciones vivas, el primer anticipo ya se puede revertir.
    await undoAdvance(shop, first.publicId);
    expect((await balance(shop)).receivable).toBe(0n);
    await expectAllCoherent(shop);
  });

  it("M-1: un anticipo sin descontar se revierte aunque haya una liquidación posterior sin descuento", async () => {
    const shop = await newShop();
    const adv = await advance(shop, 10_000n);
    await quickSale(db, shop);
    await settle(shop, { advanceDeduction: cop(0n) });
    await undoAdvance(shop, adv.publicId);
    expect((await balance(shop)).receivable).toBe(0n);
    await expectAllCoherent(shop);
  });

  it("revertir con el día de hoy cerrado se rechaza; al reabrirlo, entra", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });
    await expect(undoSettlement(shop, done.publicId)).rejects.toThrow(/cerrado/);
    await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: today(), reason: "Falta una reversa", actor: shop.owner });
    await undoSettlement(shop, done.publicId);
    expect((await balance(shop)).pendingCommission).toBe(cop(12_000n).minor);
    await expectAllCoherent(shop);
  });

  it("solo la última vigente; dos veces, rechazado; las líneas vuelven a estar pendientes", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const first = await settle(shop);
    await quickSale(db, shop);
    const second = await settle(shop);
    await expect(undoSettlement(shop, first.publicId)).rejects.toThrow(/^Solo se puede revertir la última liquidación de Andrés/);
    await undoSettlement(shop, second.publicId);
    await expect(undoSettlement(shop, second.publicId)).rejects.toThrow(/^Esta liquidación ya está revertida/);
    expect((await balance(shop)).pendingCommission).toBe(cop(12_000n).minor);
    expect((await balance(shop)).lastSettlement?.publicId).toBe(first.publicId);
    await undoSettlement(shop, first.publicId);
    expect((await balance(shop)).pendingCommission).toBe(cop(24_000n).minor);
    await expectAllCoherent(shop);
    expect(await auditCount(shop, "settlement.reverse")).toBe(2);

    const detail = await staffCommissionDetail(db, { locationId: shop.locationId, staffId: shop.barber });
    expect(detail?.settlements.map((s) => [s.status, s.canReverse])).toEqual([
      ["reversed", false],
      ["reversed", false],
    ]);
    // Y se pueden volver a liquidar, en una liquidación nueva.
    await expect(settle(shop)).resolves.toMatchObject({ number: 3n, created: true });
  });

  it("la misma clave de reversa no revierte dos veces; con otro motivo, conflicto", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    const cmd = { locationId: shop.locationId, publicId: done.publicId, reason: "Se liquidó de más", idempotencyKey: key("rev"), actor: shop.owner };
    await expect(reverseSettlement(db, cmd)).resolves.toEqual({ created: true });
    await expect(reverseSettlement(db, cmd)).resolves.toEqual({ created: false });
    await expect(reverseSettlement(db, { ...cmd, reason: "Otro motivo" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await auditCount(shop, "settlement.reverse")).toBe(1);
  });

  it("no se revierte nada de otra sede", async () => {
    const shop = await newShop();
    const other = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    await expect(undoSettlement(other, done.publicId)).rejects.toThrow(/^La liquidación no existe/);
    const adv = await advance(shop, 1_000n);
    await expect(undoAdvance(other, adv.publicId)).rejects.toThrow(/^El anticipo no existe/);
    expect(await receiptByPublicId(db, { locationId: other.locationId, publicId: done.publicId })).toBeNull();
  });
});

describe("anticipos", () => {
  it("de caja o de banco; saldo por cobrar; idempotente", async () => {
    const shop = await newShop();
    await open(shop, 20_000n);
    await expect(advance(shop, 50_000n, "cash")).rejects.toThrow(/^No hay tanto efectivo en la caja/);
    const cash = await advance(shop, 5_000n, "cash");
    const bank = await advance(shop, 2_000n, "bank");
    expect(cash.number).toBe(1n);
    expect(bank.number).toBe(2n);
    expect((await balance(shop)).receivable).toBe(cop(7_000n).minor);
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(15_000n).minor);
    await expectAllCoherent(shop);

    const cmd = { locationId: shop.locationId, staffId: shop.barber2, amount: cop(1_000n), paidFrom: "bank" as const, reason: "Adelanto", idempotencyKey: key("adv"), actor: shop.owner };
    const first = await giveAdvance(db, cmd);
    await expect(giveAdvance(db, cmd)).resolves.toEqual({ ...first, created: false });
    await expect(giveAdvance(db, { ...cmd, amount: cop(2_000n) })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await auditCount(shop, "advance.create")).toBe(3);

    await undoAdvance(shop, cash.publicId);
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(20_000n).minor);
    await expect(undoAdvance(shop, cash.publicId)).rejects.toThrow(/^Este anticipo ya está revertido/);
    await expectAllCoherent(shop);
  });

  it("revertir un anticipo ya descontado: rechazado, hasta revertir la liquidación", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const adv = await advance(shop, 5_000n);
    const done = await settle(shop);
    await expect(undoAdvance(shop, adv.publicId)).rejects.toThrow(/^La liquidación N\.º \d+ se hizo después de este anticipo y lo tiene en cuenta; revierte esa liquidación primero/);
    await undoSettlement(shop, done.publicId);
    await expect(undoAdvance(shop, adv.publicId)).resolves.toEqual({ created: true });
    await expectAllCoherent(shop);
  });

  it("exige motivo", async () => {
    const shop = await newShop();
    await expect(
      giveAdvance(db, { locationId: shop.locationId, staffId: shop.barber, amount: cop(1_000n), paidFrom: "bank", reason: " ", idempotencyKey: key(), actor: shop.owner }),
    ).rejects.toThrow(/^Escribe el motivo del anticipo/);
  });
});

describe("una anulación pendiente", () => {
  it("excluye la venta; rechazada, vuelve a pendiente y se liquida otra vez", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    await quickSale(db, shop);
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
    const first = await settle(shop);
    expect(first.payout).toBe(cop(12_000n).minor);
    expect((await balance(shop)).pendingCommission).toBe(0n);
    await expectAllCoherent(shop);

    await decideVoid(db, { locationId: shop.locationId, requestId, approve: false, note: "Sí se prestó el servicio", idempotencyKey: key("decide"), approver: shop.owner });
    expect((await balance(shop)).pendingCommission).toBe(cop(12_000n).minor);
    const second = await settle(shop);
    expect(second.payout).toBe(cop(12_000n).minor);
    expect((await balance(shop)).commissionOwed).toBe(0n);
    await expectAllCoherent(shop);
  });
});

describe("anular una venta ya liquidada", () => {
  it("avisa, descuenta en la siguiente liquidación y la deuda vuelve a 0", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    await settle(shop);
    const decided = await voidSale(shop, saleId);
    expect(decided.warning).toMatch(/La comisión de esta venta ya se le pagó a Andrés en la liquidación N\.º 0001/);
    expect((await balance(shop)).commissionOwed).toBe(-cop(12_000n).minor);
    expect((await balance(shop)).clawbacks).toBe(cop(12_000n).minor);
    await expectAllCoherent(shop);

    await quickSale(db, shop);
    const preview = await previewSettlement(db, options(shop));
    expect(preview.clawbacks).toMatchObject([{ settlementNumber: 1n, commission: cop(12_000n).minor }]);
    const next = await settle(shop);
    expect(next.payout).toBe(0n);
    expect((await balance(shop)).commissionOwed).toBe(0n);
    expect((await balance(shop)).clawbacks).toBe(0n);
    await expectAllCoherent(shop);

    const receipt = await receiptByPublicId(db, { locationId: shop.locationId, publicId: next.publicId });
    if (receipt?.kind !== "settlement") throw new Error("no es liquidación");
    expect(receipt.clawbacks).toMatchObject([{ amount: cop(12_000n).minor, settlementNumber: 1n }]);
  });

  it("una anulación después de revertir la liquidación no genera descuento", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    const done = await settle(shop);
    await undoSettlement(shop, done.publicId);
    expect((await voidSale(shop, saleId)).warning).toBeNull();
    expect(await balance(shop)).toMatchObject({ commissionOwed: 0n, clawbacks: 0n, pendingCommission: 0n });
    await expectAllCoherent(shop);
  });

  it("propinas ya pagadas de una venta anulada: se recuperan en la liquidación aunque se desmarquen", async () => {
    const shop = await newShop();
    await open(shop, 10_000n);
    const { saleId } = await quickSale(db, shop, { kind: "cash", tip: 3_000n });
    await payTips(db, { locationId: shop.locationId, staffId: shop.barber, amount: cop(3_000n), idempotencyKey: key("tips"), actor: shop.owner });
    await voidSale(shop, saleId);
    expect((await tipsOwed(db, shop.locationId)).find((t) => t.staffId === shop.barber)?.owed).toBe(-cop(3_000n).minor);
    await quickSale(db, shop, { kind: "cash" });
    const preview = await previewSettlement(db, options(shop, { includeTips: false }));
    expect(preview.tipsMandatory).toBe(true);
    expect(preview.draft.tips.minor).toBe(-cop(3_000n).minor);
    await settle(shop, { includeTips: false });
    expect((await balance(shop)).tipsOwed).toBe(0n);
    await expectAllCoherent(shop);
  });
});

describe("garantías de la base", () => {
  it("un commission_payout sin liquidación no se confirma; una reversa suelta del asiento tampoco", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const message = await dbError(
      postEntry(db, {
        locationId: shop.locationId,
        createdBy: "x",
        entry: {
          businessDate: today(),
          kind: "commission_payout",
          memo: "Sin liquidación",
          idempotencyKey: key("loose"),
          lines: [
            { account: ACCOUNTS.commissionsPayable.code, side: "debit", amount: cop(1_000n) },
            { account: ACCOUNTS.bank.code, side: "credit", amount: cop(1_000n) },
          ],
        },
      }),
    );
    expect(message).toBeTruthy();
    const done = await settle(shop);
    const [row] = await db.select({ entry: commissionSettlements.journalEntryId }).from(commissionSettlements).where(eq(commissionSettlements.id, done.settlementId));
    expect(await dbError(reverseEntry(db, { locationId: shop.locationId, entryId: row!.entry, businessDate: today(), reason: "Suelta", createdBy: "x" }))).toBeTruthy();
    const adv = await advance(shop, 1_000n);
    const [a] = await db.select({ entry: staffAdvances.journalEntryId }).from(staffAdvances).where(eq(staffAdvances.id, adv.advanceId));
    expect(await dbError(reverseEntry(db, { locationId: shop.locationId, entryId: a!.entry, businessDate: today(), reason: "Suelta", createdBy: "x" }))).toBeTruthy();
    await expectAllCoherent(shop);
  });

  it("UPDATE y DELETE prohibidos en las tablas nuevas; las líneas no se tocan salvo por la reversa", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    const adv = await advance(shop, 1_000n);
    const id = done.settlementId;
    const attempts = [
      `update commission_settlements set payout = payout + 100 where id = ${id}`,
      `update commission_settlements set note = 'x' where id = ${id}`,
      `delete from commission_settlements where id = ${id}`,
      `update commission_settlement_lines set amount = amount + 100 where settlement_id = ${id}`,
      `update commission_settlement_lines set reversed = true where settlement_id = ${id}`,
      `delete from commission_settlement_lines where settlement_id = ${id}`,
      `update staff_advances set amount = amount + 100 where id = ${adv.advanceId}`,
      `delete from staff_advances where id = ${adv.advanceId}`,
      `update audit_events set summary = 'x' where location_id = ${shop.locationId}`,
      `delete from audit_events where location_id = ${shop.locationId}`,
      `truncate audit_events`,
      `truncate commission_settlements cascade`,
    ];
    for (const statement of attempts) {
      await expect(client.query(statement), statement).rejects.toThrow();
    }
  });

  it("no se agregan líneas a una liquidación ya confirmada", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    await expect(
      db.insert(commissionSettlementLines).values({
        locationId: shop.locationId,
        settlementId: done.settlementId,
        kind: "adjustment",
        amount: cop(1_000n).minor,
        reason: "Colada",
      }),
    ).rejects.toThrow();
  });

  it("una liquidación cuyos totales no coinciden con sus líneas no se confirma", async () => {
    const shop = await newShop();
    await quickSale(db, shop);
    const done = await settle(shop);
    const [{ id: _id, ...row }] = (await db.select().from(commissionSettlements).where(eq(commissionSettlements.id, done.settlementId))) as [typeof commissionSettlements.$inferSelect];
    // Un segundo intento a mano, con otro asiento y sin líneas.
    const message = await dbError(
      db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const posted = await postEntry(t, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: {
            businessDate: today(),
            kind: "commission_payout",
            memo: "A mano",
            idempotencyKey: key("hand"),
            lines: [
              { account: ACCOUNTS.commissionsPayable.code, side: "debit", amount: cop(12_000n) },
              { account: ACCOUNTS.bank.code, side: "credit", amount: cop(12_000n) },
            ],
          },
        });
        await t.insert(commissionSettlements).values({
          ...row,
          number: 0n,
          publicId: ulid(),
          journalEntryId: posted.entryId,
          idempotencyKey: key("hand"),
        });
      }),
    );
    expect(message).toMatch(/liquidaci[oó]n/i);
    await expectAllCoherent(shop);
  });

});

describe("informes y tablero", () => {
  it("cada sección suma lo mismo que el libro, en el rango", async () => {
    const shop = await newShop();
    await open(shop, 50_000n);
    await quickSale(db, shop, { kind: "card", tip: 3_000n });
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    await quickSale(db, shop, { kind: "cash", tip: 1_000n });
    await addExpense(db, { locationId: shop.locationId, categoryId: shop.category, amount: cop(4_000n), paidFrom: "cash", description: "Toallas", idempotencyKey: key("exp"), actor: shop.owner });
    await voidSale(shop, saleId);
    await settle(shop, { paidFrom: "cash" });
    await closeCashSession(db, { locationId: shop.locationId, counted: cop(1_000n), note: "Faltó plata", idempotencyKey: key("close"), actor: shop.owner });
    const q = { locationId: shop.locationId, from: today(), to: today() };

    const { rows, totals } = await profitAndLoss(db, q);
    const pnl = assemblePnl(rows, totals);
    expect(totals.profit).toBe(totals.income - totals.expenses);
    const byStaff = await salesByStaff(db, q);
    const byService = await salesByService(db, q);
    const net = (list: { net: bigint }[]) => list.reduce((a, r) => a + r.net, 0n);
    expect(net(byStaff)).toBe(net(byService));
    expect(net(byStaff)).toBe(pnl.income.find((l) => l.code === ACCOUNTS.serviceIncome.code)?.amount.minor);
    expect(byService[0]!.totalNet).toBe(net(byService));

    const fees = await cardFees(db, q);
    const payments = await paymentMix(db, q);
    expect(fees.ledgerTotal).toBe(payments.reduce((a, p) => a + p.fees, 0n));
    expect(fees.byMethod.reduce((a, p) => a + p.fees, 0n)).toBe(fees.ledgerTotal);
    expect(payments[0]!.totalAmount).toBe(payments.reduce((a, p) => a + p.amount, 0n));

    const tips = await tipsByStaff(db, q);
    expect(tips).toHaveLength(1);
    expect(tips[0]!.tips).toBe(cop(4_000n).minor);
    expect(tips[0]!.totalTips).toBe(cop(4_000n).minor);
    expect(tips[0]!.paidOut).toBeGreaterThan(0n);

    expect(await expensesByCategory(db, q)).toMatchObject([{ name: "Insumos", paidFrom: "cash", count: 1, amount: cop(4_000n).minor }]);

    const differences = await cashDifferences(db, q);
    expect(differences.items.length).toBeGreaterThanOrEqual(1);
    expect(differences.net).toBe(differences.items.reduce((a, i) => a + i.difference, 0n));

    expect(await settlementsInPeriod(db, q)).toMatchObject([{ number: 1n, staffName: "Andrés", status: "settled" }]);
    const journal = await journalDetail(db, { ...q, limit: 1000 });
    expect(journal.reduce((a, l) => a + l.debit - l.credit, 0n)).toBe(0n);
    expect(await journalDetail(db, { ...q, limit: 2 })).toHaveLength(2);
    await expect(noShowStats(db, { ...q, timeZone: TZ })).resolves.toMatchObject({ total: { noShow: 0 } });

    // Otra sede no ve nada de esto.
    const other = await newShop();
    const empty = { locationId: other.locationId, from: today(), to: today() };
    expect(await salesByStaff(db, empty)).toEqual([]);
    expect((await profitAndLoss(db, empty)).totals).toEqual({ income: 0n, expenses: 0n, profit: 0n });
    expect(await settlementsInPeriod(db, empty)).toEqual([]);
  });

  it("inasistencias: por el inicio de la cita, sin walk-ins ni retenciones vencidas", async () => {
    const shop = await newShop();
    const stats = await noShowStats(db, { locationId: shop.locationId, from: addDays(today(), -1), to: addDays(today(), 30), timeZone: TZ });
    expect(stats.total.reservations).toBe(0);
    await quickSale(db, shop);
    const after = await noShowStats(db, { locationId: shop.locationId, from: addDays(today(), -1), to: addDays(today(), 30), timeZone: TZ });
    expect(after.total).toMatchObject({ reservations: 1, completed: 1, noShow: 0 });
    expect(after.byStaff).toMatchObject([{ name: "Andrés", completed: 1 }]);
  });

  it("el tablero: ventas, caja, alertas y por pagar", async () => {
    const shop = await newShop();
    const empty = await dashboardData(db, { locationId: shop.locationId });
    expect(empty).toMatchObject({ salesToday: 0n, servicesToday: 0, cash: { open: false, expected: null }, voidPendingCount: 0, owed: [] });
    await open(shop, 10_000n);
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Error", idempotencyKey: key("void"), actor: shop.reception });
    await advance(shop, 1_000n, "bank", shop.barber2);
    const data = await dashboardData(db, { locationId: shop.locationId });
    expect(data.salesToday).toBe(cop(30_000n).minor);
    expect(data.servicesToday).toBe(1);
    expect(data.cash).toMatchObject({ open: true, expected: cop(40_000n).minor });
    expect(data.voidPendingCount).toBe(1);
    expect(data.owed.map((o) => o.name).sort()).toEqual(["Andrés", "Bruno"]);
  });
});

describe("costo del datáfono con la regla de las propinas", () => {
  it("M-4: Σ medios − parte absorbida por las propinas = cuenta 5305", async () => {
    const shop = await newShop();
    await client.query(`update payment_methods set fee_bps = 299 where location_id = $1 and kind = 'card'`, [String(shop.locationId)]);
    await client.query(`update locations set tips_bear_card_fees = true where id = $1`, [String(shop.locationId)]);
    await quickSale(db, shop, { kind: "card", tip: 10_000n });
    await quickSale(db, shop, { kind: "card" });
    const fees = await cardFees(db, { locationId: shop.locationId, from: today(), to: today() });
    expect(fees.absorbedByTips).toBeGreaterThan(0n);
    expect(fees.byMethod.reduce((a, m) => a + m.fees, 0n) - fees.absorbedByTips).toBe(fees.ledgerTotal);
    const { rows } = await client.query<{ total: string }>(
      `select coalesce(sum(t.fee_share), 0)::text as total from sale_tips t where t.location_id = $1`,
      [String(shop.locationId)],
    );
    expect(fees.absorbedByTips).toBe(BigInt(rows[0]!.total));
    await expectAllCoherent(shop);
  });
});

describe("garantía de la bitácora", () => {
  it("L-6: la categoría de un evento tiene que ser la de su acción", async () => {
    const shop = await newShop();
    await client.query(
      `insert into audit_events (location_id, actor_user_id, action, category, target_kind, summary) values ($1, 'x', 'client.erase', 'personal', 'client', 'ok')`,
      [String(shop.locationId)],
    );
    expect(
      await dbError(
        client.query(`insert into audit_events (location_id, actor_user_id, action, category, target_kind, summary) values ($1, 'x', 'client.erase', 'finanzas', 'client', 'mal')`, [
          String(shop.locationId),
        ]),
      ),
    ).toMatch(/audit_events_action_category_check/);
  });
});

describe("auditoría de las finanzas", () => {
  it("una operación que falla no deja evento", async () => {
    const shop = await newShop();
    await expect(advance(shop, 1_000n, "cash")).rejects.toBeInstanceOf(CashError);
    await expect(previewSettlement(db, options(shop))).rejects.toBeInstanceOf(SettlementError);
    await expect(voidSale(shop, 999_999n)).rejects.toBeInstanceOf(VoidError);
    expect(await auditCount(shop, "advance.create")).toBe(0);
    expect(await auditCount(shop, "void.request")).toBe(0);
  });

  it("el resumen no lleva datos del cliente ni el motivo libre", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Lo pidió Juan Pérez, 300 123 4567", idempotencyKey: key("void"), actor: shop.reception });
    const rows = await db.select({ summary: auditEvents.summary }).from(auditEvents).where(eq(auditEvents.locationId, shop.locationId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.summary).not.toMatch(/Juan|Pérez|300 123/);
  });
});

// ─── Propiedad: cualquier secuencia deja todo cuadrado ───────────────────────

type Op =
  | { kind: "sale"; barber: 0 | 1; cash: boolean; tipMinor: bigint }
  | { kind: "pastSale"; barber: 0 | 1 }
  | { kind: "void"; pick: number }
  | { kind: "reject"; pick: number }
  | { kind: "closeDay" }
  | { kind: "reopenDay" }
  | { kind: "tips"; barber: 0 | 1; amount: bigint }
  | { kind: "advance"; barber: 0 | 1; amount: bigint; cash: boolean }
  | { kind: "settle"; barber: 0 | 1; cash: boolean; includeTips: boolean; deduct: bigint | null; adjust: bigint }
  | { kind: "undoSettlement"; barber: 0 | 1 }
  | { kind: "undoAdvance"; pick: number };

describe("propiedad: secuencias al azar", () => {
  const barber = fc.constantFrom<0 | 1>(0, 1);
  const pesos = (max: bigint) => fc.bigInt({ min: 1n, max }).map((p) => p * 1_000n);
  const op: fc.Arbitrary<Op> = fc.oneof(
    {
      // Propinas con centavos: $1.333,55 y $5,01, además de las redondas.
      arbitrary: fc.record({ kind: fc.constant("sale" as const), barber, cash: fc.boolean(), tipMinor: fc.oneof(fc.constant(0n), pesos(5n).map((p) => p * 100n), fc.constant(133_355n), fc.constant(501n)) }),
      weight: 5,
    },
    { arbitrary: fc.record({ kind: fc.constant("pastSale" as const), barber }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("void" as const), pick: fc.nat() }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("reject" as const), pick: fc.nat() }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("closeDay" as const) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("reopenDay" as const) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("tips" as const), barber, amount: pesos(4n) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("advance" as const), barber, amount: pesos(20n), cash: fc.boolean() }), weight: 2 },
    {
      arbitrary: fc.record({
        kind: fc.constant("settle" as const),
        barber,
        cash: fc.boolean(),
        includeTips: fc.boolean(),
        deduct: fc.oneof(fc.constant(null), pesos(10n)),
        adjust: fc.bigInt({ min: -8n, max: 8n }).map((p) => p * 1_000n),
      }),
      weight: 4,
    },
    { arbitrary: fc.record({ kind: fc.constant("undoSettlement" as const), barber }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("undoAdvance" as const), pick: fc.nat() }), weight: 1 },
  );
  let applied = 0;

  it("saldos = libro, líneas con a lo sumo un reclamo, asientos cuadrados e informes coherentes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 2, maxLength: 12 }), async (ops) => {
        const shop = await newShop();
        await open(shop, 100_000n);
        const who = (b: 0 | 1) => (b === 0 ? shop.barber : shop.barber2);
        const live: bigint[] = [];
        const advances: string[] = [];
        for (const o of ops) {
          try {
            switch (o.kind) {
              case "sale": {
                // quickSale cobra con el barbero por defecto; para el otro se usa el cobro directo.
                const { saleId } = await saleFor(shop, who(o.barber), o.cash, o.tipMinor);
                live.push(saleId);
                break;
              }
              case "pastSale": {
                const { saleId } = await saleFor(shop, who(o.barber), false, 0n, new Date(Date.now() - 86_400_000));
                live.push(saleId);
                break;
              }
              case "reject": {
                // La venta sigue viva: un rechazo no cambia nada de lo que se debe.
                if (live.length === 0) continue;
                const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId: live[o.pick % live.length]!, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
                await decideVoid(db, { locationId: shop.locationId, requestId, approve: false, note: "Sí se prestó", idempotencyKey: key("decide"), approver: shop.owner });
                break;
              }
              case "closeDay": {
                if (await sessionSummary(db, shop.locationId)) {
                  await closeCashSession(db, { locationId: shop.locationId, counted: fromMinor(await ledgerCash(db, shop.locationId)), note: "Cierre de prueba", idempotencyKey: key("close"), actor: shop.owner });
                }
                await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });
                break;
              }
              case "reopenDay": {
                await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: today(), reason: "Falta un registro", actor: shop.owner });
                if (!(await sessionSummary(db, shop.locationId))) {
                  await openCashSession(db, { locationId: shop.locationId, counted: fromMinor(await ledgerCash(db, shop.locationId)), note: "Reapertura", idempotencyKey: key("open"), actor: shop.owner });
                }
                break;
              }
              case "void": {
                if (live.length === 0) continue;
                const [saleId] = live.splice(o.pick % live.length, 1);
                await voidSale(shop, saleId!);
                break;
              }
              case "tips":
                await payTips(db, { locationId: shop.locationId, staffId: who(o.barber), amount: cop(o.amount), idempotencyKey: key("tips"), actor: shop.owner });
                break;
              case "advance": {
                const done = await advance(shop, o.amount, o.cash ? "cash" : "bank", who(o.barber));
                advances.push(done.publicId);
                break;
              }
              case "settle":
                await settle(shop, {
                  staffId: who(o.barber),
                  paidFrom: o.cash ? "cash" : "bank",
                  includeTips: o.includeTips,
                  advanceDeduction: o.deduct === null ? "max" : cop(o.deduct),
                  adjustments:
                    o.adjust === 0n
                      ? []
                      : [{ direction: o.adjust > 0n ? "add" : "deduct", amount: cop(o.adjust > 0n ? o.adjust : -o.adjust), reason: "Ajuste de prueba" }],
                });
                break;
              case "undoSettlement": {
                const [b] = await commissionBalances(db, shop.locationId, { staffId: who(o.barber) });
                if (!b?.lastSettlement) continue;
                await undoSettlement(shop, b.lastSettlement.publicId);
                break;
              }
              case "undoAdvance": {
                if (advances.length === 0) continue;
                const [publicId] = advances.splice(o.pick % advances.length, 1);
                await undoAdvance(shop, publicId!);
                break;
              }
            }
            applied++;
          } catch (err) {
            // Las reglas de negocio pueden rechazar un paso: lo que importa es que nada quede a medias.
            if (!(err instanceof SettlementError) && !(err instanceof CashError) && !(err instanceof VoidError) && !(err instanceof CheckoutError)) throw err;
          }
          await expectAllCoherent(shop);
        }
      }),
      { numRuns: 30 },
    );
    // La propiedad no vale nada si casi todo se rechaza.
    expect(applied).toBeGreaterThan(30);
  }, 300_000);
});

async function saleFor(shop: Shop, staffId: bigint, cash: boolean, tipMinor: bigint, now?: Date) {
  if (staffId === shop.barber) return quickSale(db, shop, { kind: cash ? "cash" : "card", tipMinor, now });
  const swapped: Shop = { ...shop, barber: staffId };
  try {
    return await quickSale(db, swapped, { kind: cash ? "cash" : "card", tipMinor, now });
  } finally {
    // Aunque el cobro se rechace, la cita ya ocupó su horario: el siguiente toma otro.
    shop.slot = swapped.slot;
  }
}
