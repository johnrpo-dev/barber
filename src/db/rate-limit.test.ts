import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_POLICIES } from "@/domain/security/rate-limit";
import { enforce, hit, pruneRateLimits, RATE_LIMIT_MESSAGE, RateLimitError, rateLimitMessage } from "./rate-limit";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Contador de límites en Postgres: INSERT … ON CONFLICT DO UPDATE … RETURNING.

let db: Db;
let client: PGlite;
let seq = 0;
const subject = () => `sujeto-${String(++seq).padStart(8, "0")}`;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("rate limit", () => {
  it("cada golpe suma uno en su ventana", async () => {
    const start = new Date("2026-10-29T10:00:00Z");
    expect(await hit(db, "b1", start)).toBe(1);
    expect(await hit(db, "b1", start)).toBe(2);
    expect(await hit(db, "b1", new Date("2026-10-29T11:00:00Z"))).toBe(1);
  });

  it("propiedad: golpes simultáneos nunca dejan pasar más que el límite por ventana", async () => {
    const limit = RATE_POLICIES.booking_start.contact![0]!.limit; // 5 por hora
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 15 }), fc.integer({ min: 0, max: 3_599 }), async (n, offsetSec) => {
        const s = subject();
        const now = new Date(Date.UTC(2026, 9, 29, 10, 0, 0) + offsetSec * 1000);
        const results = await Promise.allSettled(Array.from({ length: n }, () => enforce(db, "booking_start", { contact: s }, now)));
        const passed = results.filter((r) => r.status === "fulfilled").length;
        expect(passed).toBe(Math.min(n, limit));
        for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(RateLimitError);
      }),
      { numRuns: 25 },
    );
  });

  it("al pasar el límite el mensaje dice cuánto esperar, y la ventana siguiente vuelve a abrir", async () => {
    const s = subject();
    const now = new Date("2026-10-29T15:10:00Z");
    for (let i = 0; i < 30; i++) await enforce(db, "manage_action", { ip: s }, now);
    // Ventana de una hora que empezó a las 15:00: faltan 50 minutos.
    await expect(enforce(db, "manage_action", { ip: s }, now)).rejects.toThrow("Vas muy rápido. Espera 50 minutos y vuelve a intentar.");
    await expect(enforce(db, "manage_action", { ip: s }, new Date("2026-10-29T16:00:00Z"))).resolves.toBeUndefined();
  });

  it("si la que se pasó es la ventana de un día, el mensaje dice mañana", async () => {
    const s = subject();
    const now = new Date("2026-10-29T15:10:00Z");
    // booking_start por IP: 10 por hora y 30 por día. Repartidos en horas distintas solo salta la del día.
    for (let h = 0; h < 3; h++) for (let i = 0; i < 10; i++) await enforce(db, "booking_start", { ip: s }, new Date(now.getTime() + h * 3_600_000));
    await expect(enforce(db, "booking_start", { ip: s }, new Date(now.getTime() + 3 * 3_600_000))).rejects.toThrow(
      "Vas muy rápido. Intenta de nuevo mañana.",
    );
  });

  it("el tope global por sede no depende de IP ni celular", async () => {
    const loc = `location:${subject()}`;
    const now = new Date("2026-10-29T15:10:00Z");
    const limit = RATE_POLICIES.otp_send.location![0]!.limit;
    for (let i = 0; i < limit; i++) await enforce(db, "otp_send", { ip: subject(), contact: subject(), location: loc }, now);
    await expect(enforce(db, "otp_send", { ip: subject(), contact: subject(), location: loc }, now)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("propiedad: el mensaje siempre empieza por 'Vas muy rápido' y nunca promete menos de un minuto", () => {
    fc.assert(
      fc.property(fc.constantFrom(60, 3_600, 86_400), fc.integer({ min: 0, max: 86_400_000 }), (windowSec, rawWait) => {
        const waitMs = Math.min(rawWait, windowSec * 1000);
        const msg = rateLimitMessage(windowSec, waitMs);
        expect(msg.startsWith("Vas muy rápido")).toBe(true);
        if (windowSec >= 86_400) expect(msg).toContain("mañana");
        else if (Math.ceil(waitMs / 60_000) <= 1) expect(msg).toBe(RATE_LIMIT_MESSAGE);
        else expect(msg).toMatch(/Espera \d+ minutos/);
      }),
    );
  });

  it("la poda borra lo de hace más de 2 días", async () => {
    await hit(db, "viejo", new Date("2026-10-20T00:00:00Z"));
    await hit(db, "nuevo", new Date("2026-10-29T00:00:00Z"));
    expect(await pruneRateLimits(db, new Date("2026-10-29T12:00:00Z"))).toBeGreaterThanOrEqual(1);
    expect(await hit(db, "nuevo", new Date("2026-10-29T00:00:00Z"))).toBe(2);
  });
});
