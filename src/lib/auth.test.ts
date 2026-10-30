import type { PGlite } from "@electric-sql/pglite";
import { eq, like } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocation } from "@/db/ledger";
import { loginThrottles, rateLimitCounters, twoFactor, user } from "@/db/schema";
import { createStaffUser } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import type { Db } from "@/db/types";
import { userThrottleSubject } from "@/db/login-throttle";
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

const fromIp = (ip: string, extra: Headers = new Headers()) => {
  const h = new Headers(extra);
  h.set("x-forwarded-for", ip);
  return h;
};

describe("bloqueo atómico, por (correo, IP) y global por correo", () => {
  it("concurrencia: 20 contraseñas malas en paralelo verifican a lo sumo 5", { timeout: 90_000 }, async () => {
    const { email } = await owner();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => failure(auth().api.signInEmail({ body: { email, password: `paralela-${i}-larga` } }))),
    );
    const verified = results.filter((r) => r.status === 401).length;
    expect(verified).toBeGreaterThan(0);
    expect(verified).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(20 - verified);
  });

  it("el bloqueo duro es por (correo, IP): desde otra IP el dueño sigue pudiendo entrar", { timeout: 60_000 }, async () => {
    const { email } = await owner();
    for (let i = 0; i < 5; i++) await failure(auth().api.signInEmail({ body: { email, password: `equivocada-${i}-larga` }, headers: fromIp("203.0.113.10") }));
    expect(await failure(auth().api.signInEmail({ body: { email, password: PASSWORD }, headers: fromIp("203.0.113.10") }))).toMatchObject({ status: 429 });
    expect((await auth().api.signInEmail({ body: { email, password: PASSWORD }, headers: fromIp("198.51.100.20") })).token).toBeTruthy();
  });

  it("el límite global por correo frena un ataque repartido, pero no al navegador conocido", { timeout: 180_000 }, async () => {
    const { email } = await owner();
    // Ingreso completo (sin TOTP aún): este navegador queda conocido para ese correo.
    const first = await auth().api.signInEmail({ body: { email, password: PASSWORD }, headers: fromIp("192.0.2.1"), returnHeaders: true });
    expect(first.headers.getSetCookie().some((c) => /^better-auth\.known_device=.+; .*HttpOnly/i.test(c))).toBe(true);
    const knownCookie = cookiesFrom(first.headers)
      .get("cookie")!
      .split("; ")
      .filter((c) => c.startsWith("better-auth.known_device="))
      .join("; ");

    // 50 fallos desde 10 IP distintas (5 por IP, sin pasar el bloqueo duro de ninguna).
    for (let ip = 0; ip < 10; ip++) {
      for (let i = 0; i < 5; i++) {
        expect((await failure(auth().api.signInEmail({ body: { email, password: `repartida-${ip}-${i}` }, headers: fromIp(`198.51.100.${100 + ip}`) }))).status).toBe(401);
      }
    }
    // Una IP nueva, aun con la contraseña correcta, queda frenada por el límite global…
    expect(await failure(auth().api.signInEmail({ body: { email, password: PASSWORD }, headers: fromIp("203.0.113.200") }))).toMatchObject({
      status: 429,
      code: "ACCOUNT_LOCKED",
    });
    // …pero el navegador conocido del dueño entra.
    const ok = await auth().api.signInEmail({
      body: { email, password: PASSWORD },
      headers: fromIp("203.0.113.201", new Headers({ cookie: knownCookie })),
    });
    expect(ok.token).toBeTruthy();
    // Una cookie inventada no sirve.
    const forged = await failure(
      auth().api.signInEmail({
        body: { email, password: PASSWORD },
        headers: fromIp("203.0.113.202", new Headers({ cookie: `better-auth.known_device=9999999999.${"A".repeat(22)}` })),
      }),
    );
    expect(forged.status).toBe(429);
  });
});

describe("endpoints de better-auth que la app no usa o que no deben servir de oráculo", () => {
  it("rechaza actualizar el usuario, el correo, la contraseña o borrar la cuenta", { timeout: 60_000 }, async () => {
    const { email } = await owner();
    const signIn = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const cookies = cookiesFrom(signIn.headers);
    const api = auth().api;
    for (const attempt of [
      api.updateUser({ body: { name: "Otro" }, headers: cookies }),
      api.changeEmail({ body: { newEmail: "otro@villa.test" }, headers: cookies }),
      api.changePassword({ body: { currentPassword: PASSWORD, newPassword: "otra-clave-muy-larga" }, headers: cookies }),
      api.deleteUser({ body: { password: PASSWORD }, headers: cookies }),
    ]) {
      expect(await failure(attempt)).toMatchObject({ status: 403, code: "MANAGED_BY_VILLA" });
    }
    const [u] = await db.select({ name: user.name }).from(user).where(eq(user.email, email));
    expect(u?.name).toMatch(/^Dueño/);
  });

  it("“confiar en este dispositivo” está apagado", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const res = await failure(auth().api.verifyTOTP({ body: { code: await currentCode(userId), trustDevice: true }, headers: cookiesFrom(step1.headers) }));
    expect(res).toMatchObject({ status: 400, code: "TRUST_DEVICE_DISABLED" });
  });

  it("con sesión y TOTP activo, verificar códigos por HTTP se rechaza (no es un oráculo sin bloqueo)", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    const [backup] = await enroll(email, userId);
    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const done = await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(step1.headers), returnHeaders: true });
    const session = cookiesFrom(done.headers, cookiesFrom(step1.headers).get("cookie")!);
    // Ingreso completo con TOTP: el navegador queda conocido.
    expect(done.headers.getSetCookie().some((c) => c.startsWith("better-auth.known_device="))).toBe(true);
    const instance = auth();
    for (const [path, body] of [
      ["verify-totp", { code: "000000" }],
      ["verify-backup-code", { code: backup }],
    ] as const) {
      const res = await instance.handler(
        new Request(`${BASE}/api/auth/two-factor/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie: session.get("cookie")!, "x-forwarded-for": `203.0.113.${path.length}` },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("SECOND_FACTOR_NOT_HERE");
    }
    // El código de respaldo no se gastó.
    const again = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    expect((await auth().api.verifyBackupCode({ body: { code: backup! }, headers: cookiesFrom(again.headers) })).token).toBeTruthy();
  });

  it("la contraseña en /two-factor/* cuenta para el bloqueo: al sexto intento ni la correcta pasa", { timeout: 120_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const done = await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(step1.headers), returnHeaders: true });
    const session = cookiesFrom(done.headers, cookiesFrom(step1.headers).get("cookie")!);
    for (let i = 0; i < 5; i++) {
      expect(await failure(auth().api.generateBackupCodes({ body: { password: `equivocada-${i}-larga` }, headers: session }))).toMatchObject({
        status: 400,
        code: "INVALID_PASSWORD",
      });
    }
    expect(await failure(auth().api.disableTwoFactor({ body: { password: PASSWORD }, headers: session }))).toMatchObject({
      status: 429,
      code: "ACCOUNT_LOCKED",
    });
    const [u] = await db.select({ on: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
    expect(u?.on).toBe(true);
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

  it("20 códigos malos en paralelo repartidos en 4 retos verifican a lo sumo 5", { timeout: 120_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    const challenges: Headers[] = [];
    for (let i = 0; i < 4; i++) {
      challenges.push(cookiesFrom((await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })).headers));
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => failure(auth().api.verifyTOTP({ body: { code: String(100000 + i) }, headers: challenges[i % 4]! }))),
    );
    const verified = results.filter((r) => r.status === 401).length;
    expect(verified).toBeGreaterThan(0);
    expect(verified).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429 && r.code === "ACCOUNT_LOCKED")).toHaveLength(20 - verified);
    // Bloqueado: ni el código correcto en un reto nuevo pasa.
    const fresh = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    expect(await failure(auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(fresh.headers) }))).toMatchObject({
      status: 429,
    });
  });

  it("un cuerpo mal formado en el segundo paso no cuenta; un acierto borra la cuenta", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    const subject = userThrottleSubject("totp-login", userId);
    const failuresOf = async () => (await db.select({ failures: loginThrottles.failures }).from(loginThrottles).where(eq(loginThrottles.subject, subject)))[0]?.failures ?? 0;
    const step1 = cookiesFrom((await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })).headers);
    expect((await failure(auth().api.verifyTOTP({ body: {} as { code: string }, headers: step1 }))).status).toBe(400);
    expect(await failuresOf()).toBe(0);
    expect((await failure(auth().api.verifyTOTP({ body: { code: "000000" }, headers: step1 }))).status).toBe(401);
    expect(await failuresOf()).toBe(1);
    expect((await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: step1 })).token).toBeTruthy();
    expect(await failuresOf()).toBe(0);
  });

  it("con el TOTP activo, la contraseña sola no desactiva ni da códigos nuevos por HTTP; get-totp-uri está cerrado", { timeout: 90_000 }, async () => {
    const { email, userId } = await owner();
    await enroll(email, userId);
    const step1 = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const done = await auth().api.verifyTOTP({ body: { code: await currentCode(userId) }, headers: cookiesFrom(step1.headers), returnHeaders: true });
    const session = cookiesFrom(done.headers, cookiesFrom(step1.headers).get("cookie")!);
    const instance = auth();
    for (const [path, code] of [
      ["disable", "CODE_REQUIRED"],
      ["generate-backup-codes", "CODE_REQUIRED"],
      ["get-totp-uri", "MANAGED_BY_VILLA"],
    ] as const) {
      const res = await instance.handler(
        new Request(`${BASE}/api/auth/two-factor/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie: session.get("cookie")!, "x-forwarded-for": `203.0.113.${100 + path.length}` },
          body: JSON.stringify({ password: PASSWORD }),
        }),
      );
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code?: string }).code, path).toBe(code);
    }
    const [u] = await db.select({ on: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
    expect(u?.on).toBe(true);
  });
});
