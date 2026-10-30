import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain/booking/clock";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { closeBusinessDay, closeCashSession, ledgerCash, openCashSession } from "./cash";
import { postEntry } from "./ledger";
import { checkout } from "./sales";
import { chairAppointment, key, setupShop, simpleCheckout, TZ } from "./sales-testing";
import * as schema from "./schema";
import type { Db } from "./types";

// Concurrencia sobre un PostgreSQL de verdad (M3). PGlite tiene una sola conexión y no puede
// cruzar transacciones; aquí dos conexiones de postgres.js chocan de verdad bajo SERIALIZABLE.
//
// Solo corre con TEST_PG_URL (una base VACÍA y desechable, p. ej. villa_test): migra ahí y deja
// sedes de prueba. Nunca usa DATABASE_URL, para no tocar la base de la barbería por accidente.
//   TEST_PG_URL=postgres://villa:...@localhost:5432/villa_test npx vitest run src/db/concurrency.pg.test.ts

const url = process.env.TEST_PG_URL;
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const cop = (pesos: bigint) => fromUnits(pesos);

describe.skipIf(!url)("concurrencia en PostgreSQL real (TEST_PG_URL)", () => {
  let sqlA: postgres.Sql;
  let sqlB: postgres.Sql;
  let a: Db;
  let b: Db;

  beforeAll(async () => {
    sqlA = postgres(url!, { max: 2, onnotice: () => {} });
    sqlB = postgres(url!, { max: 2, onnotice: () => {} });
    a = drizzle({ client: sqlA, schema }) as unknown as Db;
    b = drizzle({ client: sqlB, schema }) as unknown as Db;
    await migrate(drizzle({ client: sqlA, schema }), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await sqlA?.end();
    await sqlB?.end();
  });

  it("dos cobros de la misma cita a la vez: uno entra, el otro dice que ya está cobrada", async () => {
    const shop = await setupShop(a, `Concurrencia ${key()}`);
    const appointmentId = await chairAppointment(a, shop);
    const results = await Promise.allSettled([
      checkout(a, simpleCheckout(shop, appointmentId)),
      checkout(b, simpleCheckout(shop, appointmentId)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as Error).message).toBe("Esta cita ya está cobrada");
  });

  it("dos aperturas de caja a la vez: una sola caja abierta", async () => {
    const shop = await setupShop(a, `Concurrencia ${key()}`);
    const results = await Promise.allSettled([
      openCashSession(a, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner }),
      openCashSession(b, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as Error).message).toBe("La caja ya está abierta");
  });

  it("cobro en efectivo contra cierre de caja: el cobro entra al turno o se rechaza; el libro dice lo contado", async () => {
    const shop = await setupShop(a, `Concurrencia ${key()}`);
    await openCashSession(a, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const appointmentId = await chairAppointment(a, shop);
    const [sale, closed] = await Promise.allSettled([
      checkout(a, simpleCheckout(shop, appointmentId, { kind: "cash" })),
      closeCashSession(b, { locationId: shop.locationId, counted: cop(0n), note: "Cierre con cobro en curso", idempotencyKey: key(), actor: shop.owner }),
    ]);
    expect(closed.status).toBe("fulfilled");
    const session = (closed as PromiseFulfilledResult<Awaited<ReturnType<typeof closeCashSession>>>).value;
    expect(session.expected).toBe(sale.status === "fulfilled" ? 3_000_000n : 0n);
    expect(await ledgerCash(a, shop.locationId)).toBe(0n);
  });

  it("cierre del día contra un cobro de ese día (SSI): o el cobro entra antes del cierre, o se rechaza", async () => {
    const shop = await setupShop(a, `Concurrencia ${key()}`);
    const yesterday = new Date(Date.now() - 86_400_000);
    const day = businessDate(yesterday, TZ);
    expect(day).toBe(addDays(businessDate(new Date(), TZ), -1));
    const appointmentId = await chairAppointment(a, shop);
    const [sale, close] = await Promise.allSettled([
      checkout(a, { ...simpleCheckout(shop, appointmentId), now: yesterday }),
      closeBusinessDay(b, { locationId: shop.locationId, businessDate: day, actor: shop.owner }),
    ]);
    // Ninguno queda a medias: el cierre lee los asientos del día (M1), así que si el cobro llega
    // después, uno de los dos aborta y el reintento ve el día cerrado.
    expect(close.status).toBe("fulfilled");
    if (sale.status === "rejected") expect((sale.reason as Error).message).toMatch(/cerrado/);
  });

  it("READ COMMITTED: dos salidas de efectivo a la vez no dejan 1105 negativo (candado por sede en el trigger)", async () => {
    const shop = await setupShop(a, `Concurrencia ${key()}`);
    await openCashSession(a, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    await checkout(a, simpleCheckout(shop, await chairAppointment(a, shop), { kind: "cash" }));
    // Cada una saca $20.000 de los $30.000, fuera de serializable(): solo la base las frena.
    const out = (conn: Db) =>
      conn.transaction(async (tx) => {
        await postEntry(tx as unknown as Db, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: {
            businessDate: businessDate(new Date(), TZ),
            kind: "cash_adjustment",
            memo: "Salida de prueba",
            idempotencyKey: key("salida"),
            lines: [
              { account: ACCOUNTS.cash.code, side: "credit", amount: cop(20_000n) },
              { account: ACCOUNTS.cashDifferences.code, side: "debit", amount: cop(20_000n) },
            ],
          },
        });
        // Las dos llegan al COMMIT con sus líneas ya escritas.
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
    const results = await Promise.allSettled([out(a), out(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/1105|quedaría negativo|Failed query/);
    expect(await ledgerCash(a, shop.locationId)).toBe(1_000_000n);
  });
});
