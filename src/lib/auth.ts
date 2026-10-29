import { createHmac } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";
import { z } from "zod";
import { db } from "@/db/client";
import { clearFailures, lockStatus, recordFailure, throttleSubject } from "@/db/login-throttle";
import { hit } from "@/db/rate-limit";
import { account, session, twoFactor, user, verification } from "@/db/schema";
import type { Db } from "@/db/types";
import { lockedMessage } from "@/domain/security/lockout";
import { windowStart } from "@/domain/security/rate-limit";

// Autenticación del personal (dueño, recepción, barberos). No hay registro público:
// las cuentas se crean con `npm run staff:create-owner` o desde el panel del dueño.
// Los clientes que agendan no inician sesión (ver docs/arquitectura.md).
//
// Endurecimiento (inicio del sprint 4):
// - TOTP (plugin twoFactor). Obligatorio para el dueño: src/lib/session.ts lo exige antes del panel.
// - Bloqueo por cuenta tras intentos fallidos, en Postgres (login_throttles), por correo escrito.
// - Límite de intentos por IP guardado en Postgres (rate_limit_counters), no en memoria.

export const MIN_PASSWORD_LENGTH = 12;

/** Nombre que ve el dueño en su app de autenticación. */
export const TOTP_ISSUER = "Villa";

const SIGN_IN_PATH = "/sign-in/email";

/** Correo escrito en el ingreso (sin validar: el bloqueo cuenta también correos que no existen). */
function typedEmail(body: unknown): string {
  const email = body && typeof body === "object" && "email" in body ? (body as { email: unknown }).email : "";
  return typeof email === "string" ? email : "";
}

/**
 * Detrás de Caddy en el mismo servidor: la IP real del cliente es el primer salto (desde la
 * derecha) que no es el proxy. La comparte src/lib/client-ip.ts para los límites de lo público.
 */
export const IP_ADDRESS_OPTIONS = { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["127.0.0.1", "::1"] };

export function createAuth(database: Db, opts: { secret: string; baseURL: string; plugins?: BetterAuthPlugin[] }) {
  const loginSubject = (body: unknown) => throttleSubject(opts.secret, "login", typedEmail(body));
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
      // Bloqueo por cuenta: se revisa ANTES de verificar la contraseña (un bloqueado no puede seguir
      // probando) y el mensaje es el mismo exista o no el correo.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const now = new Date();
        const until = await lockStatus(database, loginSubject(ctx.body), now);
        if (until) throw APIError.from("TOO_MANY_REQUESTS", { code: "ACCOUNT_LOCKED", message: lockedMessage(until, now) });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          // Solo cuentan las credenciales malas (401), no un correo mal escrito ni un bloqueo.
          if (returned.statusCode === 401) await recordFailure(database, loginSubject(ctx.body));
          return;
        }
        await clearFailures(database, loginSubject(ctx.body));
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
