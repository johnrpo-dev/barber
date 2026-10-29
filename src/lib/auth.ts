import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { z } from "zod";
import { db } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";
import type { Db } from "@/db/types";

// Autenticación del personal (dueño, recepción, barberos). No hay registro público:
// las cuentas se crean con `npm run staff:create-owner` o desde el panel del dueño.
// Los clientes que agendan no inician sesión (ver docs/arquitectura.md).

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Detrás de Caddy en el mismo servidor: la IP real del cliente es el primer salto (desde la
 * derecha) que no es el proxy. La comparte src/lib/client-ip.ts para los límites de lo público.
 */
export const IP_ADDRESS_OPTIONS = { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["127.0.0.1", "::1"] };

export function createAuth(database: Db, opts: { secret: string; baseURL: string; plugins?: BetterAuthPlugin[] }) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(database, { provider: "pg", schema: { user, session, account, verification } }),
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
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: {
      // Detrás de Caddy en el mismo servidor: la IP real del cliente es el primer salto que no es el
      // proxy. Sin esto, todas las peticiones caerían en el mismo cupo y un atacante podría agotar
      // el límite de intentos de ingreso para todos.
      ipAddress: { ipAddressHeaders: [...IP_ADDRESS_OPTIONS.ipAddressHeaders], trustedProxies: [...IP_ADDRESS_OPTIONS.trustedProxies] },
      // En producción la cookie de sesión siempre lleva Secure, aunque la URL se configure mal.
      useSecureCookies: process.env.NODE_ENV === "production",
    },
    plugins: opts.plugins ?? [],
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
