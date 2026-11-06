import type { PGlite } from "@electric-sql/pglite";
import { and, desc, eq, inArray } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { businessDate } from "@/domain/ledger/business-date";
import { format, fromUnits, money } from "@/domain/money";
import type { OwnerAlertKind } from "@/domain/notifications/owner-alert";
import { runOwnerAlerts } from "@/worker/jobs/owner-alerts";
import { runSecurityAlerts } from "@/worker/jobs/security-alerts";
import { closeBusinessDay, closeCashSession, ledgerCash, openCashSession, reopenBusinessDay } from "./cash";
import { giveCourtesy } from "./courtesies";
import { deliverOwnerAlerts, type OwnerAlertTransport, sweepOwnerAlerts } from "./owner-alerts";
import { chairAppointment, key, quickSale, setupShop, type Shop, TZ } from "./sales-testing";
import { dayCloseEvents, locations, ownerAlerts, staffMembers, user } from "./schema";
import { enqueueLockAlert } from "./security-alerts";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Avisos al dueño (docs/sprint-8-gastos-controles.md §3): el barrido copia a owner_alerts lo que el
// dueño debe saber, sin duplicar; el correo sale agrupado por sede, como mucho cada 15 minutos, y
// solo entonces se marca. Corre como villa_app, como en producción.

let db: Db;
let client: PGlite;
let shopSeq = 0;
const BASE = "https://villa.test";

/** Reloj de la entrega: cada llamada cae en una ventana de 15 minutos nueva (y nunca repetida). */
let clock = Date.now();
const nextWindow = () => new Date((clock += 16 * 60_000));

/** Motivos y datos del cliente que NUNCA deben aparecer en el correo. */
const SECRET = {
  void: "MOTIVO-ANULACION Juan Pérez se quejó",
  courtesy: "MOTIVO-CORTESIA cumpleaños de Juan",
  reopen: "MOTIVO-REAPERTURA faltó registrar algo",
  cash: "NOTA-CAJA plata de Juan",
};
const CLIENT_LEAKS = ["Juan", "Pérez", "300 123 4567", "3001234567", "1234567", "MOTIVO", "NOTA-CAJA"];

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const shopNames = new Map<bigint, string>();
const nameOf = (shop: Shop) => shopNames.get(shop.locationId) ?? "";

/** Una sede nueva con nombres de verdad para dueño y recepción (cuentas enlazadas) y tope de 100 %. */
async function namedShop(): Promise<Shop> {
  const name = `Sede ${++shopSeq}`;
  const shop = await setupShop(db, name);
  shopNames.set(shop.locationId, name);
  await db.update(locations).set({ maxDiscountBps: 10_000, receptionCanDiscount: true }).where(eq(locations.id, shop.locationId));
  for (const who of [shop.owner, shop.reception]) {
    await db.insert(user).values({ id: who.userId, name: who.userId, email: `${who.userId}@villa.test` });
    await db.update(staffMembers).set({ userId: who.userId }).where(eq(staffMembers.id, who.staffId));
  }
  return shop;
}

const today = () => businessDate(new Date(), TZ);

/** Cada evento devuelve el id de su fila de origen (el ref_id que debe tener su aviso). */
const events: Record<OwnerAlertKind, (shop: Shop) => Promise<bigint>> = {
  async void_requested(shop) {
    const { saleId } = await quickSale(db, shop);
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: SECRET.void, idempotencyKey: key("void"), actor: shop.reception });
    return requestId;
  },
  async cash_review(shop) {
    // Abre con lo que dice el libro y cierra con $50.000 de más: supera el umbral de $20.000.
    const book = await ledgerCash(db, shop.locationId);
    await openCashSession(db, { locationId: shop.locationId, counted: money(book), idempotencyKey: key("open"), actor: shop.reception });
    const closed = await closeCashSession(db, {
      locationId: shop.locationId,
      counted: money(book + fromUnits(50_000n).minor),
      note: SECRET.cash,
      idempotencyKey: key("close"),
      actor: shop.reception,
    });
    return closed.sessionId;
  },
  async day_reopened(shop) {
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });
    await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: today(), reason: SECRET.reopen, actor: shop.reception });
    const rows = await db
      .select({ id: dayCloseEvents.id })
      .from(dayCloseEvents)
      .where(and(eq(dayCloseEvents.locationId, shop.locationId), eq(dayCloseEvents.action, "reopen")))
      .orderBy(desc(dayCloseEvents.id))
      .limit(1);
    return rows[0]!.id;
  },
  async courtesy(shop) {
    const appointmentId = await chairAppointment(db, shop);
    const { courtesyId } = await giveCourtesy(db, { locationId: shop.locationId, appointmentId, reason: SECRET.courtesy, actor: shop.reception });
    return courtesyId;
  },
};

const alertsOf = (shop: Shop) =>
  db
    .select({ id: ownerAlerts.id, kind: ownerAlerts.kind, refId: ownerAlerts.refId, notifiedAt: ownerAlerts.notifiedAt })
    .from(ownerAlerts)
    .where(eq(ownerAlerts.locationId, shop.locationId))
    .orderBy(ownerAlerts.id);

/** Un correo de mentira que guarda lo enviado; `fail` lo hace fallar. */
function fakeMail(opts: { fail?: boolean } = {}) {
  const sent: { subject: string; text: string; key: string }[] = [];
  const transport: OwnerAlertTransport = {
    baseUrl: BASE,
    send: async (subject, text, idempotencyKey) => {
      if (opts.fail) throw new Error("resend_500");
      sent.push({ subject, text, key: idempotencyKey });
    },
  };
  return { sent, transport };
}

/** Los correos de esa sede (la entrega cubre todas las sedes de la base de pruebas). */
const mailsFor = (sent: { subject: string; text: string }[], shop: Shop) => sent.filter((m) => m.text.startsWith(`Esto pasó en ${nameOf(shop)} y`));

describe("barrido", () => {
  it("cada tipo de evento genera su aviso, con el id de su fila de origen, y repetir el barrido no duplica", async () => {
    const shop = await namedShop();
    const refs = {} as Record<OwnerAlertKind, bigint>;
    for (const kind of ["void_requested", "cash_review", "day_reopened", "courtesy"] as const) refs[kind] = await events[kind](shop);

    await sweepOwnerAlerts(db);
    const rows = await alertsOf(shop);
    expect(rows.map((r) => [r.kind, r.refId]).sort()).toEqual(Object.entries(refs).sort());
    expect(rows.every((r) => r.notifiedAt === null)).toBe(true);

    expect(await sweepOwnerAlerts(db)).toBe(0);
    expect(await alertsOf(shop)).toHaveLength(4);
  });

  it("la anulación ya decidida no se avisa; la que se decide antes del correo no sale y queda marcada", async () => {
    const shop = await namedShop();
    const decided = await events.void_requested(shop);
    await decideVoid(db, { locationId: shop.locationId, requestId: decided, approve: true, note: "", idempotencyKey: key("d"), approver: shop.owner });
    await sweepOwnerAlerts(db);
    expect(await alertsOf(shop)).toHaveLength(0);

    const later = await events.void_requested(shop);
    await sweepOwnerAlerts(db);
    expect((await alertsOf(shop)).map((r) => r.refId)).toEqual([later]);
    await decideVoid(db, { locationId: shop.locationId, requestId: later, approve: false, note: "No procede", idempotencyKey: key("d"), approver: shop.owner });

    const mail = fakeMail();
    await deliverOwnerAlerts(db, mail.transport, { now: nextWindow() });
    expect(mailsFor(mail.sent, shop)).toHaveLength(0);
    expect((await alertsOf(shop))[0]!.notifiedAt).not.toBeNull();
  });

  it("un turno con diferencia bajo el umbral no se avisa", async () => {
    const shop = await namedShop();
    const book = await ledgerCash(db, shop.locationId);
    await openCashSession(db, { locationId: shop.locationId, counted: money(book), idempotencyKey: key("open"), actor: shop.reception });
    await closeCashSession(db, { locationId: shop.locationId, counted: money(book + fromUnits(10_000n).minor), note: "Sobra poco", idempotencyKey: key("close"), actor: shop.reception });
    await sweepOwnerAlerts(db);
    expect(await alertsOf(shop)).toHaveLength(0);
  });
});

describe("entrega", () => {
  it("sin correo configurado: no marca nada y deja una sola línea por ventana, sin nombres ni montos", async () => {
    const shop = await namedShop();
    await events.courtesy(shop);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const now = nextWindow();
      const first = await runOwnerAlerts(db, now, { transport: null });
      expect(first.pending).toBeGreaterThan(0);
      expect(first.emails).toBe(0);
      await runOwnerAlerts(db, now, { transport: null });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toMatch(/sin enviar/);
      for (const leak of [...CLIENT_LEAKS, "Recepción", "Andrés", "$"]) expect(logged).not.toContain(leak);
    } finally {
      warn.mockRestore();
    }
    expect((await alertsOf(shop)).every((r) => r.notifiedAt === null)).toBe(true);

    // Cuando el correo existe, sale lo que esperaba.
    const mail = fakeMail();
    await runOwnerAlerts(db, nextWindow(), { transport: mail.transport });
    expect(mailsFor(mail.sent, shop)).toHaveLength(1);
    expect((await alertsOf(shop)).every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("con correo: UN correo agrupado por sede con quién, monto, hora y enlace; se marca y no se reenvía", async () => {
    const shop = await namedShop();
    const other = await namedShop();
    for (const kind of ["void_requested", "cash_review", "day_reopened", "courtesy"] as const) await events[kind](shop);
    await events.courtesy(other);
    await sweepOwnerAlerts(db);

    const mail = fakeMail();
    const result = await deliverOwnerAlerts(db, mail.transport, { now: nextWindow() });
    const mine = mailsFor(mail.sent, shop);
    expect(mine).toHaveLength(1);
    expect(mailsFor(mail.sent, other)).toHaveLength(1);
    expect(result.batches.find((b) => b.locationId === shop.locationId)?.alertIds).toHaveLength(4);

    const { subject, text } = mine[0]!;
    expect(subject).toBe(`Villa (${nameOf(shop)}): 4 avisos para revisar`);
    expect(text).toContain(`Anulaciones por decidir (1): ${BASE}/panel/anulaciones`);
    expect(text).toContain(`Cierres de caja por revisar (1): ${BASE}/panel/caja`);
    expect(text).toContain(`Días reabiertos (1): ${BASE}/panel/caja`);
    expect(text).toContain(`Cortesías (1): ${BASE}/panel/informes`);
    expect(text).toContain(`Recepción ${nameOf(shop)} pidió anular una venta de ${format(fromUnits(30_000n))}.`);
    expect(text).toContain(`Recepción ${nameOf(shop)} cerró la caja; cierre con sobrante de ${format(fromUnits(50_000n))}.`);
    expect(text).toContain(`Recepción ${nameOf(shop)} reabrió el día ${today()}.`);
    expect(text).toContain(`Recepción ${nameOf(shop)} dio una cortesía: Corte de ${format(fromUnits(30_000n))}, atendió Andrés.`);
    // La hora local de la sede (YYYY-MM-DD HH:MM).
    expect(text).toMatch(new RegExp(`- ${today()} \\d{1,2}:\\d{2}`));

    expect((await alertsOf(shop)).every((r) => r.notifiedAt !== null)).toBe(true);
    const again = fakeMail();
    await deliverOwnerAlerts(db, again.transport, { now: nextWindow() });
    expect(mailsFor(again.sent, shop)).toHaveLength(0);
  });

  it("el correo no lleva el motivo libre, ni la nota de caja, ni el nombre o celular del cliente", async () => {
    const shop = await namedShop();
    for (const kind of ["void_requested", "cash_review", "day_reopened", "courtesy"] as const) await events[kind](shop);
    await sweepOwnerAlerts(db);
    const mail = fakeMail();
    await deliverOwnerAlerts(db, mail.transport, { now: nextWindow() });
    const [m] = mailsFor(mail.sent, shop);
    expect(m).toBeDefined();
    for (const leak of [...CLIENT_LEAKS, ...Object.values(SECRET)]) {
      expect(m!.text).not.toContain(leak);
      expect(m!.subject).not.toContain(leak);
    }
  });

  it("como mucho un correo por sede cada 15 minutos; si el envío falla no se marca y sale en la ventana siguiente", async () => {
    const shop = await namedShop();
    await events.courtesy(shop);
    await sweepOwnerAlerts(db);

    const broken = fakeMail({ fail: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await deliverOwnerAlerts(db, broken.transport, { now: nextWindow() });
    error.mockRestore();
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect((await alertsOf(shop)).every((r) => r.notifiedAt === null)).toBe(true);

    const now = nextWindow();
    const mail = fakeMail();
    await deliverOwnerAlerts(db, mail.transport, { now });
    expect(mailsFor(mail.sent, shop)).toHaveLength(1);

    // Otro evento en la misma ventana espera a la siguiente.
    await events.courtesy(shop);
    await sweepOwnerAlerts(db);
    const same = fakeMail();
    await deliverOwnerAlerts(db, same.transport, { now: new Date(now.getTime() + 60_000) });
    expect(mailsFor(same.sent, shop)).toHaveLength(0);
    const next = fakeMail();
    await deliverOwnerAlerts(db, next.transport, { now: nextWindow() });
    expect(mailsFor(next.sent, shop)).toHaveLength(1);
    expect(mailsFor(next.sent, shop)[0]!.subject).toBe(`Villa (${nameOf(shop)}): se dio una cortesía`);
  });

  it("la app solo puede marcar notified_at, una vez, y no puede borrar avisos", async () => {
    const shop = await namedShop();
    await events.courtesy(shop);
    await sweepOwnerAlerts(db);
    const [row] = await alertsOf(shop);
    await db.update(ownerAlerts).set({ notifiedAt: new Date() }).where(eq(ownerAlerts.id, row!.id));
    expect(await dbError(db.update(ownerAlerts).set({ notifiedAt: null }).where(eq(ownerAlerts.id, row!.id)))).toMatch(/una sola vez/);
    expect(await dbError(db.update(ownerAlerts).set({ notifiedAt: new Date() }).where(eq(ownerAlerts.id, row!.id)))).toMatch(/una sola vez/);
    expect(await dbError(db.update(ownerAlerts).set({ refId: 1n }).where(eq(ownerAlerts.id, row!.id)))).toMatch(/permission denied/);
    expect(await dbError(db.delete(ownerAlerts).where(inArray(ownerAlerts.id, [row!.id])))).toMatch(/permission denied/);
  });
});

describe("lo que hace el dueño", () => {
  it("no se avisan la anulación pedida, la reapertura ni la cortesía de una cuenta con rol de dueño; el descuadre de caja sí", async () => {
    const shop = await namedShop();
    const { saleId } = await quickSale(db, shop);
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: SECRET.void, idempotencyKey: key("void"), actor: shop.owner });
    const appointmentId = await chairAppointment(db, shop);
    await giveCourtesy(db, { locationId: shop.locationId, appointmentId, reason: SECRET.courtesy, actor: shop.owner });
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });
    await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: today(), reason: SECRET.reopen, actor: shop.owner });
    const book = await ledgerCash(db, shop.locationId);
    await openCashSession(db, { locationId: shop.locationId, counted: money(book), idempotencyKey: key("open"), actor: shop.owner });
    const closed = await closeCashSession(db, {
      locationId: shop.locationId,
      counted: money(book + fromUnits(50_000n).minor),
      note: SECRET.cash,
      idempotencyKey: key("close"),
      actor: shop.owner,
    });

    await sweepOwnerAlerts(db);
    expect((await alertsOf(shop)).map((r) => [r.kind, r.refId])).toEqual([["cash_review", closed.sessionId]]);

    // Lo mismo hecho por recepción sí se avisa.
    await events.courtesy(shop);
    await sweepOwnerAlerts(db);
    expect((await alertsOf(shop)).map((r) => r.kind).sort()).toEqual(["cash_review", "courtesy"]);
  });
});

describe("configuración del correo", () => {
  /** Producción con correo pero sin WhatsApp ni Turnstile (la reserva pública no está lista). */
  const MAIL_ONLY = {
    RESEND_API_KEY: "re_test_key_no_real",
    EMAIL_FROM: "Villa <avisos@villa.test>",
    ALERT_EMAIL: "dueno@villa.test",
    PUBLIC_BASE_URL: "https://villa.test",
  };
  const UNSET = ["WHATSAPP_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TURNSTILE_SECRET", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "OTP_PEPPER", "MANAGE_LINK_SECRET"];

  function productionMailOnly() {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(MAIL_ONLY)) vi.stubEnv(name, value);
    for (const name of UNSET) vi.stubEnv(name, undefined);
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "msg_test" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const restore = () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  };
  const bodiesTo = (fetch: ReturnType<typeof productionMailOnly>) =>
    fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string } }));

  it("con Resend, ALERT_EMAIL y PUBLIC_BASE_URL, sin WhatsApp ni Turnstile, el aviso al dueño sale y se marca", async () => {
    const shop = await namedShop();
    await events.courtesy(shop);
    const fetch = productionMailOnly();
    try {
      await runOwnerAlerts(db, nextWindow());
      const mine = bodiesTo(fetch).filter((c) => c.body.text.startsWith(`Esto pasó en ${nameOf(shop)} y`));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.url).toBe("https://api.resend.com/emails");
      expect(mine[0]!.body.to).toEqual(["dueno@villa.test"]);
      expect(mine[0]!.body.text).toContain("https://villa.test/panel/informes");
    } finally {
      restore();
    }
    expect((await alertsOf(shop)).every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("si falta alguna de las cuatro variables no se envía ni se marca, y el registro dice cuáles faltan (sin valores)", async () => {
    const shop = await namedShop();
    await events.courtesy(shop);
    const fetch = productionMailOnly();
    vi.stubEnv("ALERT_EMAIL", undefined);
    vi.stubEnv("PUBLIC_BASE_URL", "no-es-url");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runOwnerAlerts(db, nextWindow());
      expect(fetch).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join(" | ");
      expect(logged).toContain("ALERT_EMAIL, PUBLIC_BASE_URL");
      expect(logged).not.toContain("RESEND_API_KEY");
      for (const value of [MAIL_ONLY.RESEND_API_KEY, "no-es-url", "avisos@villa.test"]) expect(logged).not.toContain(value);
    } finally {
      warn.mockRestore();
      restore();
    }
    expect((await alertsOf(shop)).every((r) => r.notifiedAt === null)).toBe(true);
  });

  it("el aviso de seguridad (bloqueo de ingreso) también sale sin WhatsApp ni Turnstile", async () => {
    await enqueueLockAlert(db, { kind: "login", failures: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) });
    const fetch = productionMailOnly();
    try {
      const { delivered } = await runSecurityAlerts(db, nextWindow());
      expect(delivered).toBeGreaterThanOrEqual(1);
      const calls = bodiesTo(fetch);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.to).toEqual(["dueno@villa.test"]);
    } finally {
      restore();
    }
  });
});

describe("propiedad", () => {
  type Cmd = { t: "event"; kind: OwnerAlertKind } | { t: "sweep" } | { t: "deliver"; mail: "ok" | "fail" | "none"; newWindow: boolean };
  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ t: fc.constant("event" as const), kind: fc.constantFrom<OwnerAlertKind>("void_requested", "cash_review", "day_reopened", "courtesy") }),
    fc.record({ t: fc.constant("sweep" as const) }),
    fc.record({ t: fc.constant("deliver" as const), mail: fc.constantFrom("ok" as const, "fail" as const, "none" as const), newWindow: fc.boolean() }),
  );

  it("para cualquier secuencia de eventos, barridos y entregas: un aviso por evento y cada aviso sale en un solo correo", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 7 }), async (cmds) => {
          const shop = await namedShop();
          const expected = new Set<string>();
          const sentIds: bigint[] = [];
          let now = nextWindow();
          const deliver = async (mail: "ok" | "fail" | "none") => {
            const transport = mail === "none" ? null : fakeMail({ fail: mail === "fail" }).transport;
            const r = await deliverOwnerAlerts(db, transport, { now });
            for (const b of r.batches) if (b.locationId === shop.locationId) sentIds.push(...b.alertIds);
          };
          for (const c of cmds) {
            if (c.t === "event") expected.add(`${c.kind}:${await events[c.kind](shop)}`);
            else if (c.t === "sweep") await sweepOwnerAlerts(db);
            else {
              if (c.newWindow) now = nextWindow();
              await deliver(c.mail);
            }
          }
          // Al final, con correo y en una ventana nueva, todo lo pendiente sale.
          await sweepOwnerAlerts(db);
          now = nextWindow();
          await deliver("ok");

          const rows = await alertsOf(shop);
          // Exactamente un aviso por evento (ni más, ni menos).
          expect(rows.map((r) => `${r.kind}:${r.refId}`).sort()).toEqual([...expected].sort());
          // Cada aviso salió en un solo correo, y todos salieron.
          expect(new Set(sentIds).size).toBe(sentIds.length);
          expect(sentIds.map(String).sort()).toEqual(rows.map((r) => String(r.id)).sort());
          expect(rows.every((r) => r.notifiedAt !== null)).toBe(true);
        }),
        { numRuns: 12 },
      );
    } finally {
      error.mockRestore();
    }
  }, 600_000);
});
