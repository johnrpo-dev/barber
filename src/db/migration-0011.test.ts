import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, CHART_OF_ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { postEntry } from "./ledger";
import * as schema from "./schema";
import { accounts } from "./schema";
import type { Db } from "./types";

// La migración 0011 sobre una base que ya tiene datos de 0010 (como el VPS al desplegar): los
// cierres viejos con una diferencia grande quedan marcados para revisión y los demás no; las
// funciones quedan con el search_path fijo. Antes de 0011 solo hay SQL a mano: el esquema de
// Drizzle ya tiene las columnas nuevas.

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const TZ = "America/Bogota";

let client: PGlite;
let db: Db;
let at0010: string;
let locationId: bigint;

/** Copia de las migraciones hasta 0010, con su journal recortado. */
function migrationsUpTo0010(): string {
  const dir = mkdtempSync(join(tmpdir(), "villa-0010-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  rmSync(join(dir, "0011_cash_integrity.sql"));
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 10);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const cop = (pesos: bigint) => fromUnits(pesos);
let seq = 0;

async function ledger1105(): Promise<bigint> {
  const { rows } = await client.query<{ cash: string }>(
    `select coalesce(sum(l.debit - l.credit), 0)::text as cash from journal_lines l join accounts a on a.id = l.account_id
      where l.location_id = $1 and a.code = '1105'`,
    [String(locationId)],
  );
  return BigInt(rows[0]!.cash);
}

/** Ajuste de caja (centavos con signo: + sobrante, − faltante), como lo registraba 0010. */
async function adjustment(difference: bigint, idempotencyKey: string): Promise<bigint | null> {
  if (difference === 0n) return null;
  const amount = cop((difference < 0n ? -difference : difference) / 100n);
  const short = difference < 0n;
  return (
    await postEntry(db, {
      locationId,
      createdBy: "dueño",
      entry: {
        businessDate: businessDate(new Date(), TZ),
        kind: "cash_adjustment",
        memo: "Ajuste de caja",
        idempotencyKey,
        lines: [
          { account: ACCOUNTS.cash.code, side: short ? "credit" : "debit", amount },
          { account: ACCOUNTS.cashDifferences.code, side: short ? "debit" : "credit", amount },
        ],
      },
    })
  ).entryId;
}

/**
 * Un turno de 0010: se abre contando el libro más `openingDiff` pesos (con su ajuste si difiere) y
 * se cierra con `counted` pesos, con su ajuste.
 */
async function closedSession(counted: bigint, openingDiff = 0n) {
  const n = ++seq;
  const hex = (c: string) => c.repeat(64);
  const before = await ledger1105();
  const openingEntry = await adjustment(openingDiff * 100n, `cash-open:${n}-xxxxxxxx`);
  const { rows: opened } = await client.query<{ id: string }>(
    `insert into cash_sessions (location_id, opened_by, opening_counted, opening_expected, opening_note, opening_entry_id,
                                open_idempotency_key, open_request_hash)
     values ($1, 'dueño', $2, $3, $4, $5, $6, $7) returning id::text`,
    [
      String(locationId),
      String(before + openingDiff * 100n),
      String(before),
      openingDiff === 0n ? null : "Diferencia al abrir",
      openingEntry === null ? null : String(openingEntry),
      `open-${n}-xxxxxxxx`,
      hex("a"),
    ],
  );
  const expected = await ledger1105();
  const difference = counted * 100n - expected;
  const entryId = await adjustment(difference, `cash-close:${n}-xxxxxxxx`);
  await client.query(
    `update cash_sessions set closed_by = 'dueño', closed_at = now(), closing_counted = $2, expected_cash = $3, difference = $4,
            note = $5, closing_entry_id = $6, close_idempotency_key = $7, close_request_hash = $8
      where id = $1`,
    [
      opened[0]!.id,
      String(counted * 100n),
      String(expected),
      String(difference),
      difference === 0n ? null : "Diferencia",
      entryId === null ? null : String(entryId),
      `close-${n}-xxxxxxxx`,
      hex("b"),
    ],
  );
  return BigInt(opened[0]!.id);
}

beforeAll(async () => {
  at0010 = migrationsUpTo0010();
  client = new PGlite({ extensions: { btree_gist } });
  db = drizzle({ client, schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: at0010 });
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (at0010) rmSync(at0010, { recursive: true, force: true });
});

describe("migración 0011 sobre datos de 0010", () => {
  it("marca los cierres viejos con diferencia > $20.000 y fija el search_path", { timeout: 120_000 }, async () => {
    const { rows } = await client.query<{ id: string }>(`insert into locations (name) values ('Villa vieja') returning id::text`);
    locationId = BigInt(rows[0]!.id);
    await db.insert(accounts).values(CHART_OF_ACCOUNTS.map((a) => ({ locationId, ...a })));
    // Efectivo inicial: un aporte del dueño de $100.000.
    await postEntry(db, {
      locationId,
      createdBy: "dueño",
      entry: {
        businessDate: businessDate(new Date(), TZ),
        kind: "owner_contribution",
        memo: "Aporte",
        idempotencyKey: "aporte-inicial-x",
        lines: [
          { account: ACCOUNTS.cash.code, side: "debit", amount: cop(100_000n) },
          { account: ACCOUNTS.ownerEquity.code, side: "credit", amount: cop(100_000n) },
        ],
      },
    });
    const exact = await closedSession(100_000n); // sin diferencia
    const small = await closedSession(80_000n); // faltan 20.000: igual al umbral
    const big = await closedSession(50_000n); // faltan 30.000
    const surplus = await closedSession(75_000n); // sobran 25.000
    // Apertura con faltante de 25.000 (libro 75.000, contado 50.000) y cierre exacto.
    const openingShort = await closedSession(50_000n, -25_000n);
    // Apertura con sobrante de 20.000 (igual al umbral: no) y cierre exacto.
    const openingEdge = await closedSession(70_000n, 20_000n);
    // Dispositivos de confianza de better-auth que quedaron de antes (LOW-6), y otra verificación que no se toca.
    await client.query(
      `insert into verification (id, identifier, value, expires_at) values
         ('v1', 'trust-device-abc', 'x', now() + interval '1 day'), ('v2', 'otra-cosa', 'y', now() + interval '1 day')`,
    );
    const { rows: before } = await client.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns where table_name = 'cash_sessions' and column_name = 'needs_review'`,
    );
    expect(before[0]!.n).toBe(0);

    await migrate(db as never, { migrationsFolder });

    const { rows: flags } = await client.query<{
      id: string;
      needs_review: boolean;
      opening_needs_review: boolean;
      reviewed_at: Date | null;
      closed_at: Date;
    }>(`select id::text, needs_review, opening_needs_review, reviewed_at, closed_at from cash_sessions where location_id = $1 order by id`, [
      String(locationId),
    ]);
    expect(new Map(flags.map((f) => [BigInt(f.id), [f.opening_needs_review, f.needs_review]]))).toEqual(
      new Map([
        [exact, [false, false]],
        [small, [false, false]],
        [big, [false, true]],
        [surplus, [false, true]],
        [openingShort, [true, false]],
        [openingEdge, [false, false]],
      ]),
    );
    const { rows: verifications } = await client.query<{ id: string }>(`select id from verification order by id`);
    expect(verifications.map((v) => v.id)).toEqual(["v2"]);
    expect(flags.every((f) => f.reviewed_at === null && f.closed_at !== null)).toBe(true);
    const { rows: threshold } = await client.query<{ t: string }>(`select cash_review_threshold::text as t from locations where id = $1`, [
      String(locationId),
    ]);
    expect(threshold[0]!.t).toBe("2000000");
    // El trigger de cierre quedó activo otra vez después del relleno.
    const { rows: trig } = await client.query<{ enabled: string }>(
      `select tgenabled as enabled from pg_trigger where tgname = 'cash_sessions_before_update'`,
    );
    expect(trig[0]!.enabled).toBe("O");
    const { rows: fns } = await client.query<{ config: string[] | null }>(
      `select proconfig as config from pg_proc where oid in ('ledger_assert_entry(bigint)'::regprocedure, 'app_apply_grants()'::regprocedure)`,
    );
    expect(fns).toHaveLength(2);
    for (const f of fns) expect(f.config).toContain("search_path=pg_catalog, public, pg_temp");
    // Después de 0011, el libro sigue igual: $70.000 en caja.
    const { rows: cash } = await client.query<{ cash: string }>(
      `select sum(l.debit - l.credit)::text as cash from journal_lines l join accounts a on a.id = l.account_id
        where l.location_id = $1 and a.code = '1105'`,
      [String(locationId)],
    );
    expect(cash[0]!.cash).toBe("7000000");
  });
});
