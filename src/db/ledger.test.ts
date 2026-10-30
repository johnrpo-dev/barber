import type { PGlite } from "@electric-sql/pglite";
import { count } from "drizzle-orm";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import type { JournalEntryDraft } from "@/domain/ledger/entry";
import { UnbalancedEntryError } from "@/domain/ledger/entry";
import { allocate, fromUnits, money, PESO, percentOf } from "@/domain/money";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { closeDay, createLocation, postEntry, reopenDay, reverseEntry, trialBalance } from "./ledger";
import { accounts, journalEntries } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

const DAY = "2026-10-28";
const USER = "user_test";

let db: Db;
let client: PGlite;
let locationId: bigint;

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa — Sede principal" });
}, 30_000);

/** SQL directo dentro de BEGIN/COMMIT; si falla, ROLLBACK para no dejar la conexión abortada. */
async function rawTx(statements: string): Promise<void> {
  try {
    await client.exec(`BEGIN; ${statements}; COMMIT;`);
  } catch (err) {
    await client.exec("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function accountId(code: string, location: bigint = locationId): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "select id::text as id from accounts where location_id = $1 and code = $2",
    [location.toString(), code],
  );
  return rows[0]!.id;
}

// Asientos sueltos del libro genérico: desde 0011 un asiento "sale" (o de gasto, propinas o
// consignación) exige su fila operativa al hacer COMMIT (eso lo prueban sales/cash/voids.test.ts),
// así que aquí se usa un tipo sin fila operativa; las reglas del libro son las mismas.
function haircut(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  const price = fromUnits(25_000n);
  const commission = percentOf(price, 4_000n, PESO);
  return {
    businessDate: DAY,
    kind: "owner_contribution",
    memo: "Corte clásico — Andrés",
    lines: [
      { account: ACCOUNTS.cash.code, side: "debit", amount: price },
      { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: price },
      { account: ACCOUNTS.commissionExpense.code, side: "debit", amount: commission },
      { account: ACCOUNTS.commissionsPayable.code, side: "credit", amount: commission },
    ],
    ...overrides,
  };
}

describe("libro mayor: registro de asientos", () => {
  it("crea la sede con su plan de cuentas", async () => {
    const [row] = await db.select({ n: count() }).from(accounts);
    expect(row?.n).toBe(Object.keys(ACCOUNTS).length);
  });

  it("registra un cobro y el balance de comprobación cuadra al centavo", async () => {
    const { created } = await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    expect(created).toBe(true);

    const rows = await trialBalance(db, { locationId, from: DAY, to: DAY });
    const cash = rows.find((r) => r.code === ACCOUNTS.cash.code);
    expect(cash?.debits).toBe(2_500_000n);
    expect(typeof cash?.debits).toBe("bigint");

    const debits = rows.reduce((a, r) => a + r.debits, 0n);
    const credits = rows.reduce((a, r) => a + r.credits, 0n);
    expect(debits).toBe(credits);
  });

  it("la misma clave de idempotencia no registra dos veces (doble toque en Cobrar)", async () => {
    const entry = haircut({ idempotencyKey: "cobro-cita-123" });
    const first = await postEntry(db, { locationId, entry, createdBy: USER });
    const second = await postEntry(db, { locationId, entry, createdBy: USER });
    expect(second).toEqual({ entryId: first.entryId, created: false });
    const [row] = await db.select({ n: count() }).from(journalEntries);
    expect(row?.n).toBe(1);
  });

  it("la misma clave con otro contenido es un conflicto: ni se registra ni devuelve el asiento anterior", async () => {
    await postEntry(db, { locationId, entry: haircut({ idempotencyKey: "cobro-cita-456" }), createdBy: USER });
    const otherPrice = haircut({
      idempotencyKey: "cobro-cita-456",
      lines: [
        { account: ACCOUNTS.cash.code, side: "debit", amount: fromUnits(30_000n) },
        { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: fromUnits(30_000n) },
      ],
    });
    await expect(postEntry(db, { locationId, entry: otherPrice, createdBy: USER })).rejects.toThrow(IdempotencyConflictError);
    await expect(
      postEntry(db, { locationId, entry: haircut({ idempotencyKey: "cobro-cita-456", memo: "Otro" }), createdBy: USER }),
    ).rejects.toThrow(IdempotencyConflictError);
    await expect(
      postEntry(db, { locationId, entry: haircut({ idempotencyKey: "cobro-cita-456" }), createdBy: "otra_persona" }),
    ).rejects.toThrow(IdempotencyConflictError);
    const [row] = await db.select({ n: count() }).from(journalEntries);
    expect(row?.n).toBe(1);
  });

  it("propiedad: con la misma clave, el mismo cobro se repite y uno distinto choca", async () => {
    let k = 0;
    const sale = (units: bigint, memo: string, key: string) =>
      haircut({
        idempotencyKey: key,
        memo,
        lines: [
          { account: ACCOUNTS.cash.code, side: "debit", amount: fromUnits(units) },
          { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: fromUnits(units) },
        ],
      });
    const draft = fc.record({ units: fc.bigInt({ min: 1n, max: 3n }), memo: fc.constantFrom("Corte", "Barba") });
    await fc.assert(
      fc.asyncProperty(draft, draft, async (a, b) => {
        const key = `prop-${++k}`;
        const first = await postEntry(db, { locationId, entry: sale(a.units, a.memo, key), createdBy: USER });
        const retry = postEntry(db, { locationId, entry: sale(b.units, b.memo, key), createdBy: USER });
        if (a.units === b.units && a.memo === b.memo) await expect(retry).resolves.toEqual({ entryId: first.entryId, created: false });
        else await expect(retry).rejects.toThrow(IdempotencyConflictError);
      }),
      { numRuns: 30 },
    );
    const [row] = await db.select({ n: count() }).from(journalEntries);
    expect(row?.n).toBe(k);
  }, 60_000);

  it("el dominio rechaza un asiento descuadrado antes de tocar la base", async () => {
    const entry = haircut({
      lines: [
        { account: ACCOUNTS.cash.code, side: "debit", amount: fromUnits(25_000n) },
        { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: fromUnits(24_999n) },
      ],
    });
    await expect(postEntry(db, { locationId, entry, createdBy: USER })).rejects.toThrow(UnbalancedEntryError);
  });
});

describe("libro mayor: garantías dentro de PostgreSQL (aunque el código tenga un bug)", () => {
  async function rawEntry(lines: Array<[code: string, debit: number, credit: number]>, date = DAY) {
    const values = await Promise.all(
      lines.map(
        async ([code, d, c]) =>
          `(${locationId}, currval('journal_entries_id_seq'), ${await accountId(code)}, ${d}, ${c})`,
      ),
    );
    return rawTx(`
      INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, created_by)
        VALUES (${locationId}, '${date}', 'owner_contribution', 'sql directo', 'COP', '${USER}');
      ${values.length ? `INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES ${values.join(",")}` : "SELECT 1"}
    `);
  }

  it("rechaza al hacer COMMIT un asiento descuadrado insertado con SQL directo", async () => {
    const msg = await dbError(
      rawEntry([
        [ACCOUNTS.cash.code, 2_500_000, 0],
        [ACCOUNTS.serviceIncome.code, 0, 2_499_900],
      ]),
    );
    expect(msg).toMatch(/no cuadra/);
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from journal_entries");
    expect(rows[0]?.n).toBe(0);
  });

  it("rechaza un asiento sin líneas o con una sola", async () => {
    expect(await dbError(rawEntry([]))).toMatch(/necesita al menos dos/);
    expect(await dbError(rawEntry([[ACCOUNTS.cash.code, 100, 0]]))).toMatch(/necesita al menos dos/);
  });

  it("rechaza una línea con débito y crédito a la vez o con montos negativos", async () => {
    expect(
      await dbError(
        rawEntry([
          [ACCOUNTS.cash.code, 100, 100],
          [ACCOUNTS.serviceIncome.code, 0, 0],
        ]),
      ),
    ).toMatch(/journal_lines_one_side_check/);
    expect(
      await dbError(
        rawEntry([
          [ACCOUNTS.cash.code, -100, 0],
          [ACCOUNTS.serviceIncome.code, 0, -100],
        ]),
      ),
    ).toMatch(/journal_lines_one_side_check/);
  });

  it("no permite modificar, borrar ni vaciar el libro", async () => {
    await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    expect(await dbError(client.exec("UPDATE journal_lines SET debit = debit + 100 WHERE debit > 0"))).toMatch(
      /solo-inserción/,
    );
    expect(await dbError(client.exec("UPDATE journal_entries SET memo = 'editado'"))).toMatch(/solo-inserción/);
    expect(await dbError(client.exec("DELETE FROM journal_entries"))).toMatch(/solo-inserción/);
    // Desde el sprint 4 las ventas y la caja apuntan al libro: sin CASCADE frena la FK; con CASCADE,
    // los triggers de solo-inserción del libro o de las tablas que lo referencian.
    expect(await dbError(client.exec("TRUNCATE journal_lines, journal_entries"))).toMatch(/solo-inserción|foreign key/);
    expect(await dbError(client.exec("TRUNCATE journal_lines, journal_entries CASCADE"))).toMatch(/solo-inserción|no admite TRUNCATE/);
  });

  it("no permite agregar líneas a un asiento ya confirmado", async () => {
    const { entryId } = await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    const cash = await accountId(ACCOUNTS.cash.code);
    const income = await accountId(ACCOUNTS.serviceIncome.code);
    const msg = await dbError(
      rawTx(`
        INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES
          (${locationId}, ${entryId}, ${cash}, 100, 0), (${locationId}, ${entryId}, ${income}, 0, 100)
      `),
    );
    expect(msg).toMatch(/ya está confirmado/);
  });

  it("una línea no puede usar una cuenta de otra sede", async () => {
    const otherLocation = await createLocation(db, { name: "Otra sede" });
    const foreignCash = await accountId(ACCOUNTS.cash.code, otherLocation);
    const income = await accountId(ACCOUNTS.serviceIncome.code);
    const msg = await dbError(
      rawTx(`
        INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, created_by)
          VALUES (${locationId}, '${DAY}', 'owner_contribution', 'cruce de sedes', 'COP', '${USER}');
        INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES
          (${locationId}, currval('journal_entries_id_seq'), ${foreignCash}, 100, 0),
          (${locationId}, currval('journal_entries_id_seq'), ${income}, 0, 100)
      `),
    );
    expect(msg).toMatch(/journal_lines_account_fk/);
  });

  it("rechaza un asiento en una moneda distinta a la de la sede", async () => {
    const msg = await dbError(
      client.exec(`
        INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, created_by)
          VALUES (${locationId}, '${DAY}', 'owner_contribution', 'dólares', 'USD', '${USER}');
      `),
    );
    expect(msg).toMatch(/moneda USD/);
  });
});

describe("libro mayor: días cerrados", () => {
  it("un día cerrado no acepta asientos hasta que se reabre con motivo", async () => {
    await closeDay(db, { locationId, businessDate: DAY, createdBy: USER });
    expect(await dbError(postEntry(db, { locationId, entry: haircut(), createdBy: USER }))).toMatch(/está cerrado/);

    expect(await dbError(closeDay(db, { locationId, businessDate: DAY, createdBy: USER }))).toMatch(/ya está cerrado/);

    await reopenDay(db, { locationId, businessDate: DAY, reason: "Faltó registrar un gasto", createdBy: USER });
    await expect(postEntry(db, { locationId, entry: haircut(), createdBy: USER })).resolves.toMatchObject({
      created: true,
    });
  });

  it("no se puede reabrir un día abierto ni reabrir sin motivo", async () => {
    expect(await dbError(reopenDay(db, { locationId, businessDate: DAY, reason: "x", createdBy: USER }))).toMatch(
      /no está cerrado/,
    );
    await closeDay(db, { locationId, businessDate: DAY, createdBy: USER });
    expect(
      await dbError(
        client.exec(
          `INSERT INTO day_close_events (location_id, business_date, action, created_by) VALUES (${locationId}, '${DAY}', 'reopen', '${USER}')`,
        ),
      ),
    ).toMatch(/day_close_events_reopen_reason_check/);
  });

  it("los eventos de cierre tampoco se pueden borrar", async () => {
    await closeDay(db, { locationId, businessDate: DAY, createdBy: USER });
    expect(await dbError(client.exec("DELETE FROM day_close_events"))).toMatch(/solo-inserción/);
  });
});

describe("libro mayor: reversas", () => {
  it("la reversa deja todas las cuentas en cero y se registra en otro día aunque el original esté cerrado", async () => {
    const { entryId } = await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    await closeDay(db, { locationId, businessDate: DAY, createdBy: USER });

    await reverseEntry(db, {
      locationId,
      entryId,
      businessDate: "2026-10-29",
      reason: "Cobro duplicado",
      createdBy: USER,
    });

    for (const row of await trialBalance(db, { locationId })) {
      expect(row.debits - row.credits).toBe(0n);
    }
  });

  it("un asiento se reversa una sola vez y una reversa no se reversa", async () => {
    const { entryId } = await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    const reversal = await reverseEntry(db, { locationId, entryId, businessDate: DAY, reason: "error", createdBy: USER });

    expect(
      await dbError(reverseEntry(db, { locationId, entryId, businessDate: DAY, reason: "otra vez", createdBy: USER })),
    ).toMatch(/journal_entries_reverses_entry_id_key/);
    expect(
      await dbError(
        reverseEntry(db, {
          locationId,
          entryId: reversal.entryId,
          businessDate: DAY,
          reason: "deshacer",
          createdBy: USER,
        }),
      ),
    ).toMatch(/no se puede reversar/);
  });

  it("rechaza una reversa que no es el espejo exacto del original", async () => {
    const { entryId } = await postEntry(db, { locationId, entry: haircut(), createdBy: USER });
    const cash = await accountId(ACCOUNTS.cash.code);
    const income = await accountId(ACCOUNTS.serviceIncome.code);
    // Reversa "parcial": revierte el ingreso pero olvida la comisión.
    const msg = await dbError(
      rawTx(`
        INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, reverses_entry_id, created_by)
          VALUES (${locationId}, '${DAY}', 'reversal', 'reversa parcial', 'COP', ${entryId}, '${USER}');
        INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES
          (${locationId}, currval('journal_entries_id_seq'), ${income}, 2500000, 0),
          (${locationId}, currval('journal_entries_id_seq'), ${cash}, 0, 2500000)
      `),
    );
    expect(msg).toMatch(/no es el espejo exacto/);
  });
});

describe("libro mayor: propiedad", () => {
  it("cualquier secuencia de cobros válidos deja el libro cuadrado y suma exactamente lo cobrado", async () => {
    const sale = fc.record({
      priceUnits: fc.bigInt({ min: 1_000n, max: 500_000n }),
      commissionBps: fc.bigInt({ min: 0n, max: 10_000n }),
      cashWeight: fc.bigInt({ min: 0n, max: 10n }),
      cardWeight: fc.bigInt({ min: 0n, max: 10n }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(sale, { minLength: 1, maxLength: 6 }), async (sales) => {
        // Sede nueva por corrida: el libro de cada sede está aislado por location_id.
        const loc = await createLocation(db, { name: "Propiedad" });
        let expectedIncome = 0n;

        for (const s of sales) {
          const price = fromUnits(s.priceUnits);
          const weights = s.cashWeight + s.cardWeight === 0n ? [1n, 0n] : [s.cashWeight, s.cardWeight];
          const [cash, card] = allocate(price, weights) as [typeof price, typeof price];
          const commission = percentOf(price, s.commissionBps, PESO);
          const lines: JournalEntryDraft["lines"] = [
            ...(cash.minor > 0n ? [{ account: ACCOUNTS.cash.code, side: "debit" as const, amount: cash }] : []),
            ...(card.minor > 0n ? [{ account: ACCOUNTS.bank.code, side: "debit" as const, amount: card }] : []),
            { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: price },
            ...(commission.minor > 0n
              ? [
                  { account: ACCOUNTS.commissionExpense.code, side: "debit" as const, amount: commission },
                  { account: ACCOUNTS.commissionsPayable.code, side: "credit" as const, amount: commission },
                ]
              : []),
          ];
          await postEntry(db, {
            locationId: loc,
            entry: { businessDate: DAY, kind: "owner_contribution", memo: "propiedad", lines },
            createdBy: USER,
          });
          expectedIncome += price.minor;
        }

        const rows = await trialBalance(db, { locationId: loc });
        expect(rows.reduce((a, r) => a + r.debits, 0n)).toBe(rows.reduce((a, r) => a + r.credits, 0n));
        expect(rows.find((r) => r.code === ACCOUNTS.serviceIncome.code)?.credits).toBe(expectedIncome);
        const collected = rows
          .filter((r) => r.code === ACCOUNTS.cash.code || r.code === ACCOUNTS.bank.code)
          .reduce((a, r) => a + r.debits, 0n);
        expect(money(collected)).toEqual(money(expectedIncome));
      }),
      { numRuns: 50 },
    );
  }, 180_000);
});
