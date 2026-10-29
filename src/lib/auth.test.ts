import type { PGlite } from "@electric-sql/pglite";
import { eq, like } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocation } from "@/db/ledger";
import { loginThrottles, rateLimitCounters, twoFactor, user } from "@/db/schema";
import { createStaffUser } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import type { Db } from "@/db/types";
import { createAuth } from "./auth";

// better-auth real sobre PostgreSQL en memoria: bloqueo por cuenta, límite de intentos en la base
// y verificación en dos pasos (TOTP) de punta a punta. Valores de prueba: solo existen aquí.

const SECRET = "s".repeat(32);
const BASE = "http://localhost:3000";
const PASSWORD = "navaja-y-cuero-2026";

let db: Db;
let client: PGlite;
let locationId: bigint;
let seq = 0;
const auth = () => createAuth(db, { secret: SECRET, baseURL: BASE });

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa" });
}, 60_000);

afterAll(async () => {
  await client?.close();
});

async function owner() {
  const email = `dueno${++seq}@villa.test`;
  const { userId } = await createStaffUser(db, { locationId, name: `Dueño ${seq}`, email, password: PASSWORD, role: "owner" });
  return { email, userId };
}

/** Las cookies que dejó una respuesta, listas para mandarlas en la siguiente. */
function cookiesFrom(headers: Headers, previous = ""): Headers {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => c.split("=", 2) as [string, string]));
  for (const c of headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    const name = pair!.slice(0, i);
    const value = pair!.slice(i + 1);
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  return new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string; code?: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { statusCode?: number; status?: number; message: string; body?: { code?: string; message?: string } };
    return { status: e.statusCode ?? 0, message: e.body?.message ?? e.message, code: e.body?.code };
  }
  throw new Error("Se esperaba un error");
}

/** Código TOTP vigente para el secreto guardado (cifrado) de esa persona. */
async function currentCode(userId: string): Promise<string> {
  const [row] = await db.select({ secret: twoFactor.secret }).from(twoFactor).where(eq(twoFactor.userId, userId));
  const secret = await symmetricDecrypt({ key: SECRET, data: row!.secret });
  return (await auth().api.generateTOTP({ body: { secret } })).code;
}

/** Inscribe el TOTP como lo hace la pantalla /cuenta/verificacion. Devuelve los códigos de respaldo. */
async function enroll(email: string, userId: string): Promise<string[]> {
  const signIn = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
  const cookies = cookiesFrom(signIn.headers);
  const enabled = await auth().api.enableTwoFactor({ body: { password: PASSWORD }, headers: cookies, returnHeaders: true });
  const res = enabled.response;
  if (res.method !== "totp") throw new Error("Se esperaba el método TOTP");
  expect(res.totpURI).toMatch(/^otpauth:\/\/totp\/Villa:/);
  const [pending] = await db.select({ verified: twoFactor.verified }).from(twoFactor).where(eq(twoFactor.userId, userId));
  expect(pending?.verified).toBe(false);
  await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(enabled.headers, cookies.get("cookie")!) });
  const [u] = await db.select({ on: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
  expect(u?.on).toBe(true);
  return res.backupCodes;
}

describe("bloqueo por cuenta en el ingreso", () => {
  it("al quinto fallo bloquea, aunque después llegue la contraseña correcta", { timeout: 60_000 }, async () => {
    const { email } = await owner();
    for (let i = 0; i < 5; i++) {
      expect((await failure(auth().api.signInEmail({ body: { email, password: `equivocada-${i}-larga` } }))).status).toBe(401);
    }
    const locked = await failure(auth().api.signInEmail({ body: { email, password: PASSWORD } }));
    expect(locked).toMatchObject({ status: 429, code: "ACCOUNT_LOCKED" });
    expect(locked.message).toMatch(/^Demasiados intentos\. Espera \d+ minutos? y vuelve a intentar\.$/);
  });

  it("un correo que no existe se bloquea igual: el mensaje no revela qué cuentas hay", { timeout: 60_000 }, async () => {
    const email = `nadie${++seq}@villa.test`;
    for (let i = 0; i < 5; i++) await failure(auth().api.signInEmail({ body: { email, password: `equivocada-${i}-larga` } }));
    expect(await failure(auth().api.signInEmail({ body: { email, password: PASSWORD } }))).toMatchObject({ status: 429, code: "ACCOUNT_LOCKED" });
    const subjects = (await db.select({ s: loginThrottles.subject }).from(loginThrottles)).map((r) => r.s);
    expect(subjects.every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
  });

  it("un ingreso correcto borra los fallos anteriores", { timeout: 60_000 }, async () => {
    const { email } = await owner();
    for (let i = 0; i < 4; i++) await failure(auth().api.signInEmail({ body: { email, password: `equivocada-${i}-larga` } }));
    await auth().api.signInEmail({ body: { email, password: PASSWORD } });
    // Si el contador siguiera en 4, el siguiente fallo bloquearía.
    expect((await failure(auth().api.signInEmail({ body: { email, password: "otra-equivocada-mas" } }))).status).toBe(401);
    expect((await auth().api.signInEmail({ body: { email, password: PASSWORD } })).token).toBeTruthy();
  });
});

describe("límite de intentos por IP guardado en Postgres", () => {
  it("cuenta en rate_limit_counters (sin la IP en claro) y responde 429 al pasarse", { timeout: 60_000 }, async () => {
    const instance = auth();
    const attempt = () =>
      instance.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "203.0.113.77" },
          body: JSON.stringify({ email: `ip${++seq}@villa.test`, password: "equivocada-larga-1" }),
        }),
      );
    // Ventanas fijas de 10 s: se empieza al inicio de una para que los 4 intentos caigan en la misma
    // aunque la máquina esté cargada (cada intento fallido calcula un scrypt).
    const into = Date.now() % 10_000;
    if (into > 1_000) await new Promise((r) => setTimeout(r, 10_000 - into + 50));
    const statuses = (await Promise.all([attempt(), attempt(), attempt(), attempt()])).map((r) => r.status).sort();
    expect(statuses).toEqual([401, 401, 401, 429]);
    const rows = await db.select().from(rateLimitCounters).where(like(rateLimitCounters.bucket, "auth:%"));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.map((r) => r.bucket))).not.toContain("203.0.113.77");
  });
});

describe("verificación en dos pasos (TOTP)", () => {
  it("inscrito el TOTP, la contraseña sola no abre sesión: falta el código", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    const backupCodes = await enroll(email, userId);
    expect(backupCodes).toHaveLength(10);

    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    expect(step1.response).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect("token" in step1.response).toBe(false);
    const challenge = cookiesFrom(step1.headers);

    expect((await failure(auth().api.verifyTOTP({ body: { code: "000000" }, headers: challenge }))).status).toBe(401);
    const ok = await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: challenge });
    expect(ok.token).toBeTruthy();
  });

  it("un código de respaldo sirve una sola vez", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    const [code] = await enroll(email, userId);
    const first = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    expect((await auth().api.verifyBackupCode({ body: { code: code! }, headers: cookiesFrom(first.headers) })).token).toBeTruthy();
    const second = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    expect((await failure(auth().api.verifyBackupCode({ body: { code: code! }, headers: cookiesFrom(second.headers) }))).status).toBe(401);
  });

  it("cinco códigos malos seguidos bloquean la cuenta 15 minutos", { timeout: 120_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    for (let i = 0; i < 5; i++) {
      const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
      await failure(auth().api.verifyTOTP({ body: { code: "000000" }, headers: cookiesFrom(step1.headers) }));
    }
    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const locked = await failure(auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(step1.headers) }));
    expect(locked.status).toBe(429);
    const [row] = await db.select({ lockedUntil: twoFactor.lockedUntil }).from(twoFactor).where(eq(twoFactor.userId, userId));
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });
});
