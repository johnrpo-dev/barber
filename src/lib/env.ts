import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  APP_TIMEZONE: z.string().default("America/Bogota"),
  APP_CURRENCY: z.literal("COP").default("COP"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Variables de entorno validadas. Falla al arrancar si falta algo, no a mitad de un cobro. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

// ─── Reserva pública (sprint 3) ──────────────────────────────────────────────
// Todas opcionales: el panel nunca se cae porque falte algo de lo público. Cada variable se
// valida por separado; una mal escrita cuenta como ausente y publicBookingReadiness() la reporta.

// Igual que allowsDevFallbacks (public-readiness): solo "development" y "test" relajan; lo demás es producción.
const devOrTest = () => process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

const secret = z.string().min(32, "debe tener al menos 32 caracteres");
const nonEmpty = z.string().trim().min(1);
const positiveInt = z.coerce.number().int().min(1).max(100_000);

const PUBLIC_VARS = {
  OTP_PEPPER: secret,
  MANAGE_LINK_SECRET: secret,
  PUBLIC_BASE_URL: z
    .url()
    .refine(
      (url) => devOrTest() || url.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url),
      "en producción debe empezar por https://",
    )
    .transform((url) => url.replace(/\/+$/, "")),
  TURNSTILE_SECRET: nonEmpty,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: nonEmpty,
  WHATSAPP_TOKEN: nonEmpty,
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d{5,30}$/, "debe ser el ID numérico del número"),
  WHATSAPP_APP_SECRET: nonEmpty,
  RESEND_API_KEY: nonEmpty,
  EMAIL_FROM: nonEmpty,
  ALERT_EMAIL: z.email(),
  NOTIFY_CAP_PHONE: positiveInt,
  NOTIFY_CAP_GLOBAL: positiveInt,
} as const;

type PublicVarName = keyof typeof PUBLIC_VARS;
export type PublicEnv = { [K in PublicVarName]?: z.output<(typeof PUBLIC_VARS)[K]> };

/** Variables de lo público ya validadas, y la lista de las que vienen mal (sin su valor). */
export function publicEnv(source: Record<string, string | undefined> = process.env): { values: PublicEnv; problems: string[] } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, schema] of Object.entries(PUBLIC_VARS)) {
    const raw = source[name];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = schema.safeParse(raw);
    if (parsed.success) values[name] = parsed.data;
    else problems.push(`${name} ${parsed.error.issues[0]?.message ?? "no es válida"}`);
  }
  // Los dos secretos deben ser distintos: si uno se filtra, el otro sigue protegiendo.
  if (values.OTP_PEPPER !== undefined && values.OTP_PEPPER === values.MANAGE_LINK_SECRET) {
    delete values.OTP_PEPPER;
    delete values.MANAGE_LINK_SECRET;
    problems.push("OTP_PEPPER y MANAGE_LINK_SECRET deben ser distintos");
  }
  return { values: values as PublicEnv, problems };
}
