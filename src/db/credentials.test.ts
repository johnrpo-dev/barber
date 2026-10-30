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
import {
  AccountLockedError,
  clearFailures,
  clearReservation,
  lockStatus,
  loginIpThrottleSubject,
  pruneLoginThrottles,
  releaseAttempt,
  reserveAttempt,
  throttleSubject,
  unlockAccount,
  userThrottleSubject,
} from "./login-throttle";
import { loginThrottles, session, user, verification } from "./schema";
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

  it("cambiar o reiniciar la contraseña, cerrar sesiones o retirar a alguien olvida sus dispositivos de confianza", { timeout: 30_000 }, async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const trusted = async (userId: string) => {
      const id = `trust-device-${randomUUID()}`;
      await db.insert(verification).values({ id: randomUUID(), identifier: id, value: userId, expiresAt });
      return id;
    };
    const left = async (ids: string[]) =>
      (await db.select({ identifier: verification.identifier }).from(verification)).map((r) => r.identifier).filter((i) => ids.includes(i));

    const bystander = await person();
    const theirs = await trusted(bystander.userId);
    const unrelated = `2fa-${randomUUID()}`;
    const target = await person();
    await db.insert(verification).values({ id: randomUUID(), identifier: unrelated, value: target.userId, expiresAt });

    for (const run of [
      // Primero: cambia la contraseña de prueba con la que se creó (el reinicio la reemplaza).
      async () => {
        const s = await openSession(target.userId);
        expect(await changeOwnPassword(db, { userId: target.userId, sessionId: s, currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).toBe(true);
      },
      () => resetStaffPassword(db, { locationId, staffId: target.staffId, password: NEW_PASSWORD }),
      () => revokeStaffSessions(db, { locationId, staffId: target.staffId }),
      () => setStaffActive(db, { locationId, staffId: target.staffId, active: false }),
    ]) {
      const mine = await trusted(target.userId);
      await run();
      expect((await left([mine, theirs, unrelated])).sort()).toEqual([theirs, unrelated].sort());
    }
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
  const reauth = (subject: string) => [{ subject, kind: "reauth" as const }];

  it("reserva el intento antes de verificar: al quinto bloquea, con espera creciente, y un acierto lo borra", async () => {
    const subject = throttleSubject("s".repeat(32), "login", `  Alguien${++seq}@Villa.test `);
    const t0 = new Date("2026-11-02T15:00:00Z");
    for (let i = 1; i <= 4; i++) await reserveAttempt(db, reauth(subject), t0);
    expect(await lockStatus(db, subject, t0)).toBeNull();
    // El quinto intento sí se verifica, pero ya deja puesto el bloqueo para los siguientes.
    await reserveAttempt(db, reauth(subject), t0);
    expect(await lockStatus(db, subject, t0)).toEqual(new Date(t0.getTime() + 60_000));
    await expect(reserveAttempt(db, reauth(subject), t0)).rejects.toThrow(AccountLockedError);
    await expect(reserveAttempt(db, reauth(subject), t0)).rejects.toThrow(/Demasiados intentos/);
    expect(await lockStatus(db, subject, new Date(t0.getTime() + 60_000))).toBeNull();
    await reserveAttempt(db, reauth(subject), new Date(t0.getTime() + 61_000));
    expect((await lockStatus(db, subject, t0))?.getTime()).toBe(t0.getTime() + 61_000 + 120_000);
    await clearFailures(db, subject);
    expect(await lockStatus(db, subject, t0)).toBeNull();
  });

  it("concurrencia: muchos intentos en paralelo no verifican más que el umbral", async () => {
    const { userId } = await person();
    const subject = userThrottleSubject("reauth", userId);
    let verifications = 0;
    const attempt = async () => {
      const reservation = await reserveAttempt(db, reauth(subject));
      verifications++;
      if (await verifyUserPassword(db, userId, "no-es-la-clave-larga")) await clearReservation(db, reservation);
    };
    const results = await Promise.allSettled(Array.from({ length: 20 }, attempt));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(verifications).toBeLessThanOrEqual(LOCKOUT_POLICY.threshold);
    expect(rejected).toHaveLength(20 - verifications);
    expect(rejected.every((r) => r.reason instanceof AccountLockedError)).toBe(true);
  }, 60_000);

  it("un intento que no verificó nada se devuelve y quita el bloqueo que había puesto", async () => {
    const subject = userThrottleSubject("password", `devuelto-${++seq}`);
    const t0 = new Date("2026-11-02T15:00:00Z");
    for (let i = 1; i <= 4; i++) await reserveAttempt(db, reauth(subject), t0);
    const fifth = await reserveAttempt(db, reauth(subject), t0);
    expect(await lockStatus(db, subject, t0)).not.toBeNull();
    await releaseAttempt(db, fifth);
    expect(await lockStatus(db, subject, t0)).toBeNull();
    const [row] = await db.select({ failures: loginThrottles.failures }).from(loginThrottles).where(eq(loginThrottles.subject, subject));
    expect(row?.failures).toBe(4);
    const lone = userThrottleSubject("password", `solo-${++seq}`);
    await releaseAttempt(db, await reserveAttempt(db, reauth(lone), t0));
    expect(await db.select().from(loginThrottles).where(eq(loginThrottles.subject, lone))).toEqual([]);
  });

  it("el sujeto es un hash: ni el correo, ni la IP, ni el usuario quedan en claro", async () => {
    const secret = "s".repeat(32);
    const subject = throttleSubject(secret, "login", "dueno@villa.co");
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    expect(throttleSubject(secret, "login", "  DUENO@villa.co ")).toBe(subject);
    expect(userThrottleSubject("reauth", "u1")).not.toBe(userThrottleSubject("password", "u1"));
    const pair = loginIpThrottleSubject(secret, "dueno@villa.co", "203.0.113.7");
    expect(pair).toMatch(/^[0-9a-f]{64}$/);
    expect(pair).not.toBe(loginIpThrottleSubject(secret, "dueno@villa.co", "203.0.113.8"));
    // Mismo correo, otra IP: comparten la primera mitad (así se desbloquea un correo sin saber sus IP).
    expect(pair.slice(0, 32)).toBe(loginIpThrottleSubject(secret, "DUENO@villa.co", "198.51.100.1").slice(0, 32));
  });

  it("propiedad: con un bloqueo vigente no se cuenta ni se acorta nada, y nunca pasa del tope", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 20 * 60_000 }), { minLength: 1, maxLength: 12 }), async (gaps) => {
        const subject = userThrottleSubject("reauth", `prop-${++seq}`);
        let now = new Date("2026-11-02T15:00:00Z").getTime();
        for (const gap of gaps) {
          now += gap;
          const [before] = await db.select().from(loginThrottles).where(eq(loginThrottles.subject, subject));
          const lockedBefore = before?.lockedUntil && before.lockedUntil.getTime() > now ? before : null;
          const outcome = await reserveAttempt(db, reauth(subject), new Date(now)).then(
            () => "reserved",
            (err: unknown) => {
              if (err instanceof AccountLockedError) return "locked";
              throw err;
            },
          );
          const [after] = await db.select().from(loginThrottles).where(eq(loginThrottles.subject, subject));
          expect(outcome).toBe(lockedBefore ? "locked" : "reserved");
          if (lockedBefore) expect(after).toEqual(lockedBefore);
          if (after?.lockedUntil) expect(after.lockedUntil.getTime() - after.lastFailureAt.getTime()).toBeLessThanOrEqual(LOCKOUT_POLICY.maxMs);
        }
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it("staff:unlock borra los bloqueos de un correo en todas sus IP, y solo los suyos", async () => {
    const secret = "s".repeat(32);
    const { userId } = await person();
    const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    const email = u!.email;
    const mine = [
      throttleSubject(secret, "login", email),
      loginIpThrottleSubject(secret, email, "203.0.113.7"),
      loginIpThrottleSubject(secret, email, "2001:db8:1:2::"),
      userThrottleSubject("reauth", userId),
    ];
    const other = loginIpThrottleSubject(secret, "otra@villa.test", "203.0.113.7");
    for (const s of [...mine, other]) await reserveAttempt(db, reauth(s));
    expect(await unlockAccount(db, { secret, email: ` ${email.toUpperCase()} ` })).toBe(mine.length);
    const left = (await db.select({ s: loginThrottles.subject }).from(loginThrottles)).map((r) => r.s);
    for (const s of mine) expect(left).not.toContain(s);
    expect(left).toContain(other);
  });

  it("el mantenimiento borra lo viejo y deja lo que aún cuenta", async () => {
    const now = new Date("2026-12-01T12:00:00Z");
    const old = userThrottleSubject("reauth", `old-${++seq}`);
    const recent = userThrottleSubject("reauth", `recent-${++seq}`);
    await reserveAttempt(db, reauth(old), new Date(now.getTime() - LOCKOUT_POLICY.resetAfterMs - 1));
    await reserveAttempt(db, reauth(recent), new Date(now.getTime() - 60_000));
    await pruneLoginThrottles(db, now);
    const subjects = (await db.select({ s: loginThrottles.subject }).from(loginThrottles)).map((r) => r.s);
    expect(subjects).not.toContain(old);
    expect(subjects).toContain(recent);
  });
});
