import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCKOUT_POLICY } from "@/domain/security/lockout";
import {
  changeOwnPassword,
  markReauthenticated,
  resetStaffPassword,
  revokeStaffSessions,
  sessionAuthInfo,
  verifyUserPassword,
} from "./credentials";
import { createLocation } from "./ledger";
import { assertNotLocked, clearFailures, lockStatus, pruneLoginThrottles, recordFailure, throttleSubject, userThrottleSubject } from "./login-throttle";
import { loginThrottles, session, user } from "./schema";
import { addStaffMember, createStaffUser, setStaffActive, StaffError } from "./staff";
import { createTestDb } from "./testing";
import type { Db } from "./types";

const PASSWORD = "navaja-y-cuero-2026"; // valor de prueba, solo existe en esta base en memoria
const NEW_PASSWORD = "cuero-y-navaja-2027";

let db: Db;
let client: PGlite;
let locationId: bigint;
let seq = 0;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa" });
  // Siempre queda un dueño activo (withOwnerGuard), así se puede retirar a cualquiera en los tests.
  await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
}, 60_000);

afterAll(async () => {
  await client?.close();
});

async function person(opts: { mustChangePassword?: boolean } = {}) {
  const k = ++seq;
  const { userId, staffId } = await createStaffUser(db, {
    locationId,
    name: `Persona ${k}`,
    email: `p${k}@villa.test`,
    password: PASSWORD,
    role: "barber",
    mustChangePassword: opts.mustChangePassword,
  });
  return { userId, staffId };
}

async function openSession(userId: string, createdAt = new Date()): Promise<string> {
  const id = randomUUID();
  await db.insert(session).values({ id, token: randomUUID(), userId, expiresAt: new Date(Date.now() + 3_600_000), createdAt });
  return id;
}

async function sessionsOf(userId: string): Promise<string[]> {
  return (await db.select({ id: session.id }).from(session).where(eq(session.userId, userId))).map((r) => r.id);
}

describe("contraseña temporal y cambio de contraseña", () => {
  it("quien recibe una contraseña temporal queda marcado; al cambiarla se cierra todo menos su sesión", { timeout: 30_000 }, async () => {
    const { userId } = await person({ mustChangePassword: true });
    const mine = await openSession(userId);
    const other = await openSession(userId);
    expect((await sessionAuthInfo(db, { userId, sessionId: mine })).mustChangePassword).toBe(true);

    expect(await changeOwnPassword(db, { userId, sessionId: mine, currentPassword: "otra-cosa-larga", newPassword: NEW_PASSWORD })).toBe(false);
    expect(await sessionsOf(userId)).toHaveLength(2);

    expect(await changeOwnPassword(db, { userId, sessionId: mine, currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).toBe(true);
    expect(await sessionsOf(userId)).toEqual([mine]);
    expect(await sessionsOf(userId)).not.toContain(other);
    expect((await sessionAuthInfo(db, { userId, sessionId: mine })).mustChangePassword).toBe(false);
    expect(await verifyUserPassword(db, userId, NEW_PASSWORD)).toBe(true);
    expect(await verifyUserPassword(db, userId, PASSWORD)).toBe(false);
  });

  it("la nueva debe ser distinta y tener al menos 12 caracteres", async () => {
    const { userId } = await person();
    const s = await openSession(userId);
    await expect(changeOwnPassword(db, { userId, sessionId: s, currentPassword: PASSWORD, newPassword: PASSWORD })).rejects.toThrow(StaffError);
    await expect(changeOwnPassword(db, { userId, sessionId: s, currentPassword: PASSWORD, newPassword: "corta" })).rejects.toThrow(StaffError);
  });

  it("el dueño reinicia la contraseña: queda temporal y se cierran TODAS las sesiones", { timeout: 30_000 }, async () => {
    const { userId, staffId } = await person();
    await openSession(userId);
    await openSession(userId);
    await resetStaffPassword(db, { locationId, staffId, password: NEW_PASSWORD });
    expect(await sessionsOf(userId)).toEqual([]);
    const [u] = await db.select({ must: user.mustChangePassword }).from(user).where(eq(user.id, userId));
    expect(u?.must).toBe(true);
    expect(await verifyUserPassword(db, userId, NEW_PASSWORD)).toBe(true);
  });

  it("no se reinicia a quien no tiene acceso ni a alguien de otra sede", async () => {
    const noAccess = await addStaffMember(db, { locationId, displayName: "Sin acceso", role: "barber" });
    await expect(resetStaffPassword(db, { locationId, staffId: noAccess, password: NEW_PASSWORD })).rejects.toThrow(/no tiene acceso/);
    const other = await createLocation(db, { name: "Otra" });
    const { staffId } = await person();
    await expect(resetStaffPassword(db, { locationId: other, staffId, password: NEW_PASSWORD })).rejects.toThrow(/no existe en esta sede/);
  });
});

describe("cerrar sesiones", () => {
  it("cierra todas las sesiones de una persona de la sede", async () => {
    const { userId, staffId } = await person();
    await openSession(userId);
    await openSession(userId);
    expect(await revokeStaffSessions(db, { locationId, staffId })).toBe(2);
    expect(await sessionsOf(userId)).toEqual([]);
  });

  it("retirar a alguien cierra sus sesiones en la misma transacción", async () => {
    const { userId, staffId } = await person();
    await openSession(userId);
    await setStaffActive(db, { locationId, staffId, active: false });
    expect(await sessionsOf(userId)).toEqual([]);
  });
});

describe("reautenticación", () => {
  it("guarda la hora en la sesión y la lee como la última prueba de identidad", async () => {
    const { userId } = await person();
    const old = new Date(Date.now() - 3_600_000);
    const s = await openSession(userId, old);
    expect((await sessionAuthInfo(db, { userId, sessionId: s })).reauthenticatedAt).toBeNull();
    const now = new Date();
    await markReauthenticated(db, { userId, sessionId: s, now });
    const info = await sessionAuthInfo(db, { userId, sessionId: s });
    expect(info.sessionCreatedAt?.getTime()).toBe(old.getTime());
    expect(info.reauthenticatedAt?.getTime()).toBe(now.getTime());
  });

  it("no marca la sesión de otra persona", async () => {
    const a = await person();
    const b = await person();
    const s = await openSession(a.userId);
    await expect(markReauthenticated(db, { userId: b.userId, sessionId: s })).rejects.toThrow(StaffError);
  });
});

describe("bloqueo por cuenta en la base", () => {
  it("bloquea al quinto fallo con espera creciente y un acierto lo borra", async () => {
    const subject = throttleSubject("s".repeat(32), "login", `  Alguien${++seq}@Villa.test `);
    const t0 = new Date("2026-11-02T15:00:00Z");
    for (let i = 1; i <= 4; i++) expect((await recordFailure(db, subject, t0)).lockedUntil).toBeNull();
    const fifth = await recordFailure(db, subject, t0);
    expect(fifth).toEqual({ failures: 5, lockedUntil: new Date(t0.getTime() + 60_000) });
    await expect(assertNotLocked(db, subject, t0)).rejects.toThrow(/Demasiados intentos/);
    expect(await lockStatus(db, subject, new Date(t0.getTime() + 60_000))).toBeNull();
    const sixth = await recordFailure(db, subject, new Date(t0.getTime() + 61_000));
    expect(sixth.lockedUntil?.getTime()).toBe(t0.getTime() + 61_000 + 120_000);
    await clearFailures(db, subject);
    expect(await lockStatus(db, subject, t0)).toBeNull();
  });

  it("el sujeto es un hash: ni el correo ni el usuario quedan en claro", async () => {
    const subject = throttleSubject("s".repeat(32), "login", "dueno@villa.co");
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    expect(throttleSubject("s".repeat(32), "login", "  DUENO@villa.co ")).toBe(subject);
    expect(userThrottleSubject("reauth", "u1")).not.toBe(userThrottleSubject("password", "u1"));
  });

  it("propiedad: un fallo nunca acorta un bloqueo vigente y nunca pasa del tope", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 20 * 60_000 }), { minLength: 1, maxLength: 12 }), async (gaps) => {
        const subject = userThrottleSubject("reauth", `prop-${++seq}`);
        let now = new Date("2026-11-02T15:00:00Z").getTime();
        let previous: number | null = null;
        for (const gap of gaps) {
          now += gap;
          const { lockedUntil } = await recordFailure(db, subject, new Date(now));
          if (lockedUntil) expect(lockedUntil.getTime() - now).toBeLessThanOrEqual(LOCKOUT_POLICY.maxMs);
          const [row] = await db.select({ lockedUntil: loginThrottles.lockedUntil }).from(loginThrottles).where(eq(loginThrottles.subject, subject));
          const stored = row?.lockedUntil?.getTime() ?? null;
          // Un bloqueo vigente sigue ahí, igual o más largo.
          if (previous !== null && previous > now) expect(stored).toBeGreaterThanOrEqual(previous);
          previous = stored;
        }
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it("el mantenimiento borra lo viejo y deja lo que aún cuenta", async () => {
    const now = new Date("2026-12-01T12:00:00Z");
    const old = userThrottleSubject("reauth", `old-${++seq}`);
    const recent = userThrottleSubject("reauth", `recent-${++seq}`);
    await recordFailure(db, old, new Date(now.getTime() - LOCKOUT_POLICY.resetAfterMs - 1));
    await recordFailure(db, recent, new Date(now.getTime() - 60_000));
    await pruneLoginThrottles(db, now);
    const subjects = (await db.select({ s: loginThrottles.subject }).from(loginThrottles)).map((r) => r.s);
    expect(subjects).not.toContain(old);
    expect(subjects).toContain(recent);
  });
});
