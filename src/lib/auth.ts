import { createHmac } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx, isAPIError } from "better-auth/api";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";
import { z } from "zod";
import { db } from "@/db/client";
import {
  AccountLockedError,
  clearFailures,
  clearReservation,
  loginIpThrottleSubject,
  releaseAttempt,
  reserveAttempt,
  type ThrottleTarget,
  throttleSubject,
  userThrottleSubject,
} from "@/db/login-throttle";
import { hit } from "@/db/rate-limit";
import { account, session, twoFactor, user, verification } from "@/db/schema";
import type { Db } from "@/db/types";
import { isKnownDevice, KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_MAX_AGE_S, withKnownDevice } from "@/domain/security/known-device";
import { LOGIN_EMAIL_POLICY } from "@/domain/security/lockout";
import { windowStart } from "@/domain/security/rate-limit";

// Autenticación del personal (dueño, recepción, barberos). No hay registro público:
// las cuentas se crean con `npm run staff:create-owner` o desde el panel del dueño.
// Los clientes que agendan no inician sesión (ver docs/arquitectura.md).
//
// Endurecimiento (inicio del sprint 4):
// - TOTP (plugin twoFactor). Obligatorio para el dueño: src/lib/session.ts lo exige antes del panel.
// - Bloqueo por cuenta tras intentos fallidos, en Postgres (login_throttles). El intento se reserva
//   ANTES de verificar (src/db/login-throttle.ts): duro por (correo, IP) y blando por correo, del
//   que se libra un navegador donde ya se ingresó completo (cookie "dispositivo conocido").
// - Límite de intentos por IP guardado en Postgres (rate_limit_counters), no en memoria.
// - La cuenta se gestiona desde la app (Mi cuenta y el panel), no con los endpoints genéricos de
//   better-auth: /update-user, /change-email, /delete-user, /set-password, /change-password y
//   /two-factor/get-totp-uri se rechazan. Con el TOTP activo, desactivarlo o generar códigos de
//   respaldo pide además un código (acciones de Mi cuenta), no solo la contraseña.
// - El código del segundo paso del ingreso también se reserva antes de verificarse, por usuario.

export const MIN_PASSWORD_LENGTH = 12;

/** Nombre que ve el dueño en su app de autenticación. */
export const TOTP_ISSUER = "Villa";

const SIGN_IN_PATH = "/sign-in/email";

/** La app tiene sus propias acciones para esto (con reautenticación y bloqueo): fuera de /api/auth. */
export const BLOCKED_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/update-user",
  "/change-email",
  "/delete-user",
  "/set-password",
  "/change-password",
  // Con la contraseña sola devolvería el secreto del TOTP: la app no lo usa (la inscripción lo recibe de /enable).
  "/two-factor/get-totp-uri",
]);

/** Segundo factor: solo para el ingreso o para terminar de inscribir el TOTP. */
const SECOND_FACTOR_PATHS: ReadonlySet<string> = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);

/** Endpoints del plugin que piden la contraseña: pasan por el mismo bloqueo que "cambiar contraseña". */
const PASSWORD_TWO_FACTOR_PATHS: ReadonlySet<string> = new Set(["/two-factor/enable", "/two-factor/disable", "/two-factor/generate-backup-codes"]);

/**
 * Con el TOTP activo, estos piden también un código: por HTTP se rechazan y se hacen desde las
 * acciones de Mi cuenta, que verifican el código con su bloqueo y luego llaman a auth.api.
 */
const CODE_GUARDED_PATHS: ReadonlySet<string> = new Set(["/two-factor/disable", "/two-factor/generate-backup-codes"]);

const TWO_FACTOR_COOKIE = "two_factor";

/** Campo de texto del cuerpo (sin validar: el bloqueo cuenta también correos que no existen). */
function bodyText(body: unknown, field: "email" | "password"): string {
  const value = body && typeof body === "object" && field in body ? (body as Record<string, unknown>)[field] : "";
  return typeof value === "string" ? value : "";
}

const typedEmail = (body: unknown) => bodyText(body, "email");

/** "Confiar en este dispositivo" de better-auth saltaría el segundo factor por 30 días: no se usa. */
function asksTrustDevice(body: unknown): boolean {
  return !!body && typeof body === "object" && "trustDevice" in body && (body as { trustDevice: unknown }).trustDevice !== undefined;
}

function lockedError(err: AccountLockedError) {
  return APIError.from("TOO_MANY_REQUESTS", { code: "ACCOUNT_LOCKED", message: err.message });
}

/**
 * Detrás de Caddy en el mismo servidor: la IP real del cliente es el primer salto (desde la
 * derecha) que no es el proxy. La comparte src/lib/client-ip.ts para los límites de lo público.
 */
export const IP_ADDRESS_OPTIONS = { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["127.0.0.1", "::1"] };

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function createAuth(database: Db, opts: { secret: string; baseURL: string; plugins?: BetterAuthPlugin[] }) {
  const knownDeviceCookie = (ctx: HookContext) => ctx.context.createAuthCookie(KNOWN_DEVICE_COOKIE, { maxAge: KNOWN_DEVICE_MAX_AGE_S });

  /**
   * Lo que cuenta un intento de ingreso: siempre el par (correo, cubeta de IP) y, salvo en un
   * dispositivo conocido para ese correo, el límite global del correo. Es determinista: el hook
   * "after" lo recalcula igual que el "before".
   */
  const signInTargets = (ctx: HookContext, now: Date): ThrottleTarget[] => {
    const email = typedEmail(ctx.body);
    const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? "sin-ip";
    const targets: ThrottleTarget[] = [{ subject: loginIpThrottleSubject(opts.secret, email, ip), kind: "login-ip" }];
    if (!isKnownDevice(opts.secret, ctx.getCookie(knownDeviceCookie(ctx).name), email, now)) {
      targets.push({ subject: throttleSubject(opts.secret, "login", email), kind: "login", policy: LOGIN_EMAIL_POLICY });
    }
    return targets;
  };

  const markKnownDevice = (ctx: HookContext, email: string) => {
    const cookie = knownDeviceCookie(ctx);
    ctx.setCookie(cookie.name, withKnownDevice(opts.secret, ctx.getCookie(cookie.name), email, new Date()), cookie.attributes);
  };

  /**
   * Ingreso a medias (sin sesión): de quién es el reto del segundo paso. La cookie firmada lleva el
   * identificador del registro de verificación, cuyo valor es el id del usuario (como lo resuelve
   * el plugin en verify-two-factor).
   */
  const challengeUserId = async (ctx: HookContext): Promise<string | null> => {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!challenge) return null;
    const row = await ctx.context.internalAdapter.findVerificationValue(challenge);
    return row?.value ?? null;
  };

  /**
   * Contraseña en /two-factor/*: se reserva el intento (sujeto "password", el mismo de cambiar la
   * contraseña), se verifica aquí y solo un acierto sigue al endpoint (que la vuelve a verificar).
   */
  const guardTwoFactorPassword = async (ctx: HookContext) => {
    const current = await getSessionFromCtx(ctx);
    if (!current) return; // el endpoint responde 401
    let reservation;
    try {
      reservation = await reserveAttempt(database, [{ subject: userThrottleSubject("password", current.user.id), kind: "password" }]);
    } catch (err) {
      if (err instanceof AccountLockedError) throw lockedError(err);
      throw err;
    }
    const password = bodyText(ctx.body, "password");
    const credential = await ctx.context.internalAdapter.findCredentialAccount(current.user.id);
    const ok =
      !!credential?.password &&
      password.length > 0 &&
      password.length <= 128 &&
      (await ctx.context.password.verify({ hash: credential.password, password }));
    if (!ok) throw APIError.from("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "La contraseña no es correcta." });
    await clearReservation(database, reservation);
  };

  return betterAuth({
    appName: TOTP_ISSUER,
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(database, { provider: "pg", schema: { user, session, account, verification, twoFactor } }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    session: {
      // Un turno largo de barbería; después hay que volver a ingresar.
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      // En Postgres y no en memoria: vale para todos los procesos y sobrevive a un reinicio.
      // Ventana fija con el mismo contador atómico de lo público; la cubeta lleva un HMAC de la
      // clave de better-auth (IP + ruta), nunca la IP en claro. El mantenimiento diario la borra.
      customStorage: {
        consume: async (key, rule) => {
          const now = new Date();
          const windowSec = Math.max(1, Math.round(rule.window));
          const start = windowStart(now, windowSec);
          const bucket = `auth:${windowSec}:${createHmac("sha256", opts.secret).update(`villa:auth-rate:${key}`).digest("hex")}`;
          const hits = await hit(database, bucket, start);
          if (hits <= rule.max) return { allowed: true, retryAfter: null };
          return { allowed: false, retryAfter: Math.max(1, Math.ceil((start.getTime() + windowSec * 1000 - now.getTime()) / 1000)) };
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (BLOCKED_AUTH_PATHS.has(ctx.path)) {
          throw APIError.from("FORBIDDEN", { code: "MANAGED_BY_VILLA", message: "Esto se hace desde Mi cuenta o desde el panel de Villa." });
        }
        if (asksTrustDevice(ctx.body)) {
          throw APIError.from("BAD_REQUEST", { code: "TRUST_DEVICE_DISABLED", message: "Villa pide el código en cada ingreso." });
        }
        // Con sesión y el TOTP ya activo, verificar un código por HTTP no sirve para nada legítimo y
        // sería un oráculo sin bloqueo. La reautenticación los verifica desde el servidor
        // (auth.api, sin `request`), detrás de su propio bloqueo (src/app/cuenta/actions.ts).
        if (SECOND_FACTOR_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx);
          if (current?.user.twoFactorEnabled && ctx.request) {
            throw APIError.from("FORBIDDEN", { code: "SECOND_FACTOR_NOT_HERE", message: "Para confirmar tu identidad usa la ventana de Villa." });
          }
          if (!current) {
            // Segundo paso del ingreso: el intento se reserva por usuario ANTES de verificar el código.
            // El plugin cuenta 5 por reto, pero revisa y suma por separado; con varios retos en
            // paralelo se podían probar más. Aquí, a lo sumo `threshold` llegan a verificar.
            const userId = await challengeUserId(ctx);
            if (userId) {
              try {
                await reserveAttempt(database, [{ subject: userThrottleSubject("totp-login", userId), kind: "totp-login" }]);
              } catch (err) {
                if (err instanceof AccountLockedError) throw lockedError(err);
                throw err;
              }
            }
          }
        }
        if (CODE_GUARDED_PATHS.has(ctx.path) && ctx.request) {
          const current = await getSessionFromCtx(ctx);
          if (current?.user.twoFactorEnabled) {
            throw APIError.from("FORBIDDEN", { code: "CODE_REQUIRED", message: "Esto se hace desde Mi cuenta, con el código de tu app." });
          }
        }
        if (PASSWORD_TWO_FACTOR_PATHS.has(ctx.path)) await guardTwoFactorPassword(ctx);
        if (ctx.path !== SIGN_IN_PATH) return;
        // Bloqueo por cuenta: el intento se reserva ANTES de verificar la contraseña (ni un bloqueado
        // ni N peticiones en paralelo pueden seguir probando) y el mensaje es el mismo exista o no
        // el correo.
        try {
          await reserveAttempt(database, signInTargets(ctx, new Date()));
        } catch (err) {
          if (err instanceof AccountLockedError) throw lockedError(err);
          throw err;
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (SECOND_FACTOR_PATHS.has(ctx.path)) {
          const created = ctx.context.newSession;
          if (!isAPIError(returned) && created) {
            // Ingreso completo (o inscripción terminada): se borra la cuenta del segundo paso y este
            // navegador queda como conocido.
            await clearFailures(database, userThrottleSubject("totp-login", created.user.id));
            markKnownDevice(ctx, created.user.email);
            return;
          }
          // Solo cuenta un código equivocado (401); un cuerpo mal formado devuelve el intento. El reto
          // sigue en la base (solo un acierto o el agotamiento lo consumen, y ese es 401).
          if (isAPIError(returned) && returned.statusCode !== 401 && !(await getSessionFromCtx(ctx))) {
            const userId = await challengeUserId(ctx);
            if (userId) await releaseAttempt(database, { targets: [{ subject: userThrottleSubject("totp-login", userId), kind: "totp-login" }] });
          }
          return;
        }
        if (ctx.path !== SIGN_IN_PATH) return;
        const [pair, global] = signInTargets(ctx, new Date());
        if (isAPIError(returned)) {
          // Solo cuentan las credenciales malas (401); un correo mal escrito (400) devuelve el intento.
          if (returned.statusCode !== 401) await releaseAttempt(database, { targets: global ? [pair!, global] : [pair!] });
          return;
        }
        // Contraseña correcta: se borra el par (correo, IP); del límite global solo se descuenta
        // este intento, así un acierto del dueño no le regala cupo a quien ataca desde otras IP.
        await clearFailures(database, pair!.subject);
        if (global) await releaseAttempt(database, { targets: [global] });
        // Este hook corre antes que el del plugin: con TOTP activo la sesión aún no es definitiva.
        const created = ctx.context.newSession;
        if (created && !created.user.twoFactorEnabled) markKnownDevice(ctx, created.user.email);
      }),
    },
    plugins: [
      twoFactorPlugin({
        issuer: TOTP_ISSUER,
        // 6 dígitos cada 30 s: lo que esperan Google Authenticator, Microsoft Authenticator y 1Password.
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
        // Códigos TOTP o de respaldo equivocados al ingresar: bloqueo de la cuenta.
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      }),
      ...(opts.plugins ?? []),
    ],
    advanced: {
      // Detrás de Caddy en el mismo servidor: la IP real del cliente es el primer salto que no es el
      // proxy. Sin esto, todas las peticiones caerían en el mismo cupo y un atacante podría agotar
      // el límite de intentos de ingreso para todos.
      ipAddress: { ipAddressHeaders: [...IP_ADDRESS_OPTIONS.ipAddressHeaders], trustedProxies: [...IP_ADDRESS_OPTIONS.trustedProxies] },
      // En producción la cookie de sesión siempre lleva Secure, aunque la URL se configure mal.
      useSecureCookies: process.env.NODE_ENV === "production",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET debe tener al menos 32 caracteres"),
  BETTER_AUTH_URL: z.url().refine(
    // En producción solo HTTPS (si no, la cookie de sesión viajaría sin cifrar); localhost se permite para `npm start` local.
    (url) => process.env.NODE_ENV !== "production" || url.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url),
    "En producción BETTER_AUTH_URL debe empezar por https://",
  ),
});

let cached: Auth | undefined;

/** Instancia de la app. Perezosa para que `next build` no exija las variables de entorno. */
export async function auth(): Promise<Auth> {
  if (!cached) {
    const env = authEnvSchema.parse(process.env);
    // Import dinámico: next-js arrastra next/headers, que no existe en scripts ni tests.
    const { nextCookies } = await import("better-auth/next-js");
    cached = createAuth(db(), { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, plugins: [nextCookies()] });
  }
  return cached;
}
