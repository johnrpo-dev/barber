import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { courtesyReason } from "@/domain/sales/courtesy";
import { changeStatus, createAppointment } from "./appointments";
import { appointmentsToCharge, closeBusinessDay } from "./cash";
import { courtesyAppointmentIds, giveCourtesy } from "./courtesies";
import { courtesiesByStaff } from "./reports";
import { checkout } from "./sales";
import { chairAppointment, key, setupShop, simpleCheckout, TZ, type Shop } from "./sales-testing";
import { appointmentCourtesies, locations } from "./schema";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Cortesía (docs/sprint-8-gastos-controles.md §4): una cita atendida que el negocio regala. Es un
// registro aparte, no una venta: no toca el libro, ni la comisión; la cita sale de "Por cobrar" y ya no
// se puede cobrar. Corre como villa_app, como en producción.

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;
/** Hora fija de la prueba: el día contable no cambia aunque la prueba cruce la medianoche. */
const NOW = new Date();
const TODAY = businessDate(NOW, TZ);

async function one<T>(sqlText: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sqlText, params);
  return rows[0]!;
}
const journalCount = async (locationId: bigint) => Number((await one<{ n: string }>(`select count(*)::text as n from journal_entries where location_id = $1`, [String(locationId)])).n);
const auditCount = async (locationId: bigint) =>
  Number((await one<{ n: string }>(`select count(*)::text as n from audit_events where location_id = $1 and action = 'appointment.courtesy'`, [String(locationId)])).n);

async function setRules(s: Shop, rules: { maxDiscountBps: number; receptionCanDiscount?: boolean }) {
  await db
    .update(locations)
    .set({ maxDiscountBps: rules.maxDiscountBps, receptionCanDiscount: rules.receptionCanDiscount ?? false })
    .where(eq(locations.id, s.locationId));
}

const courtesy = (s: Shop, appointmentId: bigint, opts: { actor?: Shop["owner"] | Shop["reception"]; reason?: string; now?: Date } = {}) =>
  giveCourtesy(db, { locationId: s.locationId, appointmentId, reason: opts.reason ?? "Cliente frecuente, cumpleaños", actor: opts.actor ?? s.owner, now: opts.now ?? NOW });

/** Una cita agendada (confirmada), sin pasar a la silla. */
async function bookedAppointment(s: Shop): Promise<bigint> {
  const k = s.slot++;
  const date = addDays(TODAY, 2 + Math.floor(k / 20));
  const { appointmentId } = await createAppointment(db, {
    locationId: s.locationId,
    serviceId: s.service,
    staffId: s.barber,
    start: localMinuteToInstant(date, 6 * 60 + (k % 20) * 45, TZ),
    clientId: s.client,
    source: "staff",
    idempotencyKey: key("appt"),
    createdBy: s.owner.userId,
  });
  return appointmentId;
}

/** El día de "Por cobrar" de una cita (chairAppointment agenda días adelante). */
async function dayOf(appointmentId: bigint): Promise<string> {
  return (await one<{ d: string }>(`select (lower(during) at time zone 'America/Bogota')::date::text as d from appointments where id = $1`, [String(appointmentId)])).d;
}

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
  shop = await setupShop(db, "Villa");
  other = await setupShop(db, "Otra sede");
  await setRules(shop, { maxDiscountBps: 10_000 });
  await setRules(other, { maxDiscountBps: 10_000 });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("motivo de la cortesía", () => {
  it("una línea, sin espacios de sobra, de 3 a 300 caracteres", () => {
    expect(courtesyReason("  Cumpleaños\n del  cliente ")).toBe("Cumpleaños del cliente");
    expect(() => courtesyReason(" a\n ")).toThrow(/al menos 3/);
    expect(() => courtesyReason("x".repeat(301))).toThrow(/muy largo/);
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        let out: string;
        try {
          out = courtesyReason(s);
        } catch {
          return;
        }
        expect([...out].length).toBeGreaterThanOrEqual(3);
        expect([...out].length).toBeLessThanOrEqual(300);
        expect(out).toBe(out.trim());
        expect(/[\u0000-\u001f\u007f20282029]/.test(out)).toBe(false);
      }),
    );
  });
});

describe("dar una cortesía", () => {
  it("la cita en la silla queda terminada, sale de Por cobrar, con el precio de lista congelado; el libro no cambia", async () => {
    const id = await chairAppointment(db, shop);
    const day = await dayOf(id);
    expect((await appointmentsToCharge(db, shop.locationId, day)).map((a) => a.appointmentId)).toContain(id);
    const journal = await journalCount(shop.locationId);
    const audits = await auditCount(shop.locationId);

    const done = await courtesy(shop, id);
    expect(done.created).toBe(true);

    const [row] = await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.id, done.courtesyId));
    expect(row).toMatchObject({
      locationId: shop.locationId,
      appointmentId: id,
      staffId: shop.barber,
      listPrice: fromUnits(30_000n).minor,
      reason: "Cliente frecuente, cumpleaños",
      businessDate: TODAY,
      createdBy: shop.owner.userId,
    });
    expect((await one<{ status: string }>(`select status from appointments where id = $1`, [String(id)])).status).toBe("completed");
    expect((await appointmentsToCharge(db, shop.locationId, day)).map((a) => a.appointmentId)).not.toContain(id);
    // Ni asiento, ni venta, ni comisión.
    expect(await journalCount(shop.locationId)).toBe(journal);
    expect((await one<{ n: string }>(`select count(*)::text as n from sales where appointment_id = $1`, [String(id)])).n).toBe("0");
    // Un evento en la bitácora, sin el cliente ni el motivo.
    expect(await auditCount(shop.locationId)).toBe(audits + 1);
    const event = await one<{ summary: string; target_ref: string }>(
      `select summary, target_ref from audit_events where location_id = $1 and action = 'appointment.courtesy' order by id desc limit 1`,
      [String(shop.locationId)],
    );
    expect(event.summary).toContain("Corte");
    expect(event.summary).not.toContain("Juan");
    expect(event.summary).not.toContain("cumpleaños");
  });

  it("repetir devuelve la misma cortesía, sin duplicarla ni otro evento", async () => {
    const id = await chairAppointment(db, shop, { completed: true });
    const first = await courtesy(shop, id);
    const audits = await auditCount(shop.locationId);
    const again = await courtesy(shop, id, { reason: "Otro motivo distinto" });
    expect(again).toEqual({ courtesyId: first.courtesyId, created: false });
    const rows = await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.appointmentId, id));
    expect(rows).toHaveLength(1);
    expect(await auditCount(shop.locationId)).toBe(audits);
  });

  it("cobrarla después falla con un mensaje claro y no deja asiento", async () => {
    const id = await chairAppointment(db, shop);
    await courtesy(shop, id);
    const journal = await journalCount(shop.locationId);
    await expect(checkout(db, simpleCheckout(shop, id))).rejects.toThrow(/cortesía/);
    expect(await journalCount(shop.locationId)).toBe(journal);
  });

  it("no se da a una cita ya cobrada", async () => {
    const id = await chairAppointment(db, shop);
    await checkout(db, simpleCheckout(shop, id));
    await expect(courtesy(shop, id)).rejects.toThrow(/ya está cobrada/);
  });

  it("no se da a una cita que no ha pasado a la silla ni a una cancelada", async () => {
    const id = await bookedAppointment(shop);
    await expect(courtesy(shop, id)).rejects.toThrow(/en la silla o terminada/);
    await changeStatus(db, { locationId: shop.locationId, appointmentId: id, to: "cancelled", actor: shop.owner, cancelReason: "staff" });
    await expect(courtesy(shop, id)).rejects.toThrow(/cancelada/);
    expect(await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.appointmentId, id))).toEqual([]);
  });

  it("no se da a una cita marcada 'No vino'", async () => {
    const id = await bookedAppointment(shop);
    await client.query(`update appointments set status = 'no_show' where id = $1`, [String(id)]);
    const status = (await one<{ status: string }>(`select status from appointments where id = $1`, [String(id)])).status;
    expect(status).toBe("no_show");
    await expect(courtesy(shop, id)).rejects.toThrow(/no vino/);
  });

  it("solo con el tope de descuento en 100 % y solo quien puede dar descuentos", async () => {
    const id = await chairAppointment(db, shop);
    await setRules(shop, { maxDiscountBps: 9_999 });
    await expect(courtesy(shop, id)).rejects.toThrow(/tope de descuento/);
    await setRules(shop, { maxDiscountBps: 10_000, receptionCanDiscount: false });
    await expect(courtesy(shop, id, { actor: shop.reception })).rejects.toThrow(/permiso/);
    await setRules(shop, { maxDiscountBps: 10_000, receptionCanDiscount: true });
    expect((await courtesy(shop, id, { actor: shop.reception })).created).toBe(true);
    await setRules(shop, { maxDiscountBps: 10_000 });
    expect(await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.appointmentId, id))).toHaveLength(1);
  });

  it("no alcanza una cita de otra sede", async () => {
    const id = await chairAppointment(db, shop);
    await expect(courtesy(other, id)).rejects.toThrow(/no existe/);
    expect(await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.appointmentId, id))).toEqual([]);
  });

  it("no entra en un día cerrado", async () => {
    const id = await chairAppointment(db, shop);
    const past = new Date(NOW.getTime() - 20 * 86_400_000);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: businessDate(past, TZ), actor: { userId: "seed" } });
    await expect(courtesy(shop, id, { now: past })).rejects.toThrow(/cerrado/);
    expect(await db.select().from(appointmentCourtesies).where(eq(appointmentCourtesies.appointmentId, id))).toEqual([]);
  });

  it("la base rechaza un motivo con saltos de línea y no deja editar ni borrar", async () => {
    const id = await chairAppointment(db, shop);
    const done = await courtesy(shop, id);
    const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
    expect(await err(client.query(`update appointment_courtesies set list_price = 0 where id = $1`, [String(done.courtesyId)]))).toMatch(/permission denied/);
    expect(await err(client.query(`delete from appointment_courtesies where id = $1`, [String(done.courtesyId)]))).toMatch(/permission denied/);
    const other = await chairAppointment(db, shop);
    expect(
      await err(
        client.query(
          `insert into appointment_courtesies (location_id, appointment_id, staff_id, list_price, reason, business_date, created_by)
           values ($1, $2, $3, 3000000, $4, current_date, 'x')`,
          [String(shop.locationId), String(other), String(shop.barber), "dos\nlíneas"],
        ),
      ),
    ).toMatch(/appointment_courtesies_reason_check/);
  });
});

describe("informe de cortesías", () => {
  it("por barbero, con el precio de lista sumado en SQL y sin cruzar sedes", async () => {
    const before = await courtesiesByStaff(db, { locationId: shop.locationId, from: TODAY, to: TODAY });
    const a = await chairAppointment(db, shop, { staffId: shop.barber2 });
    await courtesy(shop, a);
    const after = await courtesiesByStaff(db, { locationId: shop.locationId, from: TODAY, to: TODAY });
    const bruno = (r: typeof after) => r.rows.find((x) => x.staffId === shop.barber2);
    expect((bruno(after)?.courtesies ?? 0) - (bruno(before)?.courtesies ?? 0)).toBe(1);
    expect(after.total.listPrice - before.total.listPrice).toBe(fromUnits(30_000n).minor);
    expect(await courtesiesByStaff(db, { locationId: other.locationId, from: TODAY, to: TODAY })).toEqual({ rows: [], total: { courtesies: 0, listPrice: 0n } });
    expect(await courtesiesByStaff(db, { locationId: shop.locationId, from: addDays(TODAY, 1), to: addDays(TODAY, 1) })).toEqual({ rows: [], total: { courtesies: 0, listPrice: 0n } });
  });
});

// ─── Propiedad: cortesías y cobros en cualquier orden ────────────────────────

describe("propiedad: cortesías y cobros sobre las mismas citas", () => {
  it("ninguna cita queda cobrada y con cortesía; manda lo primero que entró; el informe suma lo mismo que las filas", async () => {
    const op = fc.record({ kind: fc.constantFrom("courtesy" as const, "checkout" as const), index: fc.nat({ max: 2 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
        const ids = [await chairAppointment(db, shop), await chairAppointment(db, shop, { completed: true }), await chairAppointment(db, shop, { staffId: shop.barber2 })];
        const first: ("courtesy" | "checkout" | undefined)[] = [undefined, undefined, undefined];
        const journal = await journalCount(shop.locationId);
        let sales = 0;
        for (const o of ops) {
          const id = ids[o.index]!;
          const ok = await (o.kind === "courtesy" ? courtesy(shop, id) : checkout(db, { ...simpleCheckout(shop, id), idempotencyKey: key("p") })).then(
            () => true,
            () => false,
          );
          // Lo primero que entra manda: una cortesía repetida devuelve la misma; todo lo demás se rechaza.
          const expected = first[o.index] === undefined || (first[o.index] === "courtesy" && o.kind === "courtesy");
          expect(ok).toBe(expected);
          if (ok && first[o.index] === undefined) {
            first[o.index] = o.kind;
            if (o.kind === "checkout") sales++;
          }
        }
        for (const [i, id] of ids.entries()) {
          const state = await one<{ paid: string; courtesies: string }>(
            `select (select count(*) from sales where appointment_id = $1 and status = 'paid')::text as paid,
                    (select count(*) from appointment_courtesies where appointment_id = $1)::text as courtesies`,
            [String(id)],
          );
          expect(Number(state.paid) + Number(state.courtesies)).toBeLessThanOrEqual(1);
          expect(Number(state.paid)).toBe(first[i] === "checkout" ? 1 : 0);
          expect(Number(state.courtesies)).toBe(first[i] === "courtesy" ? 1 : 0);
        }
        // Solo las ventas mueven el libro.
        expect(await journalCount(shop.locationId)).toBe(journal + sales);

        // El informe del periodo = la suma de list_price de las cortesías del periodo, por persona.
        const report = await courtesiesByStaff(db, { locationId: shop.locationId, from: TODAY, to: TODAY });
        const rows = await db
          .select({ staffId: appointmentCourtesies.staffId, listPrice: appointmentCourtesies.listPrice })
          .from(appointmentCourtesies)
          .where(and(eq(appointmentCourtesies.locationId, shop.locationId), eq(appointmentCourtesies.businessDate, TODAY)));
        expect(report.total.listPrice).toBe(rows.reduce((acc, r) => acc + r.listPrice, 0n));
        expect(report.total.courtesies).toBe(rows.length);
        for (const r of report.rows) {
          const mine = rows.filter((x) => x.staffId === r.staffId);
          expect(r.courtesies).toBe(mine.length);
          expect(r.listPrice).toBe(mine.reduce((acc, x) => acc + x.listPrice, 0n));
        }
        expect(report.rows.reduce((acc, r) => acc + r.listPrice, 0n)).toBe(report.total.listPrice);
      }),
      { numRuns: 15 },
    );
  }, 300_000);
});

describe("agenda", () => {
  it("courtesyAppointmentIds marca solo las citas con cortesía de esa sede (la agenda no ofrece Cobrar en ellas)", async () => {
    const given = await chairAppointment(db, shop);
    const plain = await chairAppointment(db, shop);
    await courtesy(shop, given);
    expect(await courtesyAppointmentIds(db, shop.locationId, [given, plain])).toEqual(new Set([given]));
    expect(await courtesyAppointmentIds(db, other.locationId, [given, plain])).toEqual(new Set());
    expect(await courtesyAppointmentIds(db, shop.locationId, [])).toEqual(new Set());
  });
});
