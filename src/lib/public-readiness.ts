import { createHmac } from "node:crypto";
import type { NotificationChannel } from "@/domain/notifications/templates";
import { DEFAULT_CAPS } from "@/domain/notifications/quota";
import { publicEnv } from "./env";

// ¿Se puede abrir la reserva pública? Falla cerrado: sin secretos, sin Turnstile o sin WhatsApp
// (el único canal del código), /reservar muestra "Reserva por teléfono" y el panel sigue
// funcionando. Solo con NODE_ENV "development" o "test" se usan secretos fijos de desarrollo,
// el verificador falso y el notificador de consola.

/** Solo para desarrollo y tests. Nunca fuera de NODE_ENV "development" o "test" (ver publicConfig). */
export const DEV_ONLY_OTP_PEPPER = "dev-only-otp-pepper::NO-USAR-EN-PRODUCCION::villa";
export const DEV_ONLY_MANAGE_LINK_SECRET = "dev-only-manage-link-secret::NO-USAR-EN-PRODUCCION::villa";
const DEV_BASE_URL = "http://localhost:3000";

export const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Lo de desarrollo (secretos fijos, verificador falso, consola) solo con NODE_ENV exactamente
 * "development" o "test". Cualquier otro valor, incluso sin definir (p. ej. el worker con tsx),
 * se trata como producción: falla cerrado.
 */
export const allowsDevFallbacks = () => process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

export interface PublicConfig {
  otpPepper: string;
  manageLinkSecret: string;
  /** Sin barra final: "https://villa.example". */
  baseUrl: string;
  turnstile: { secret: string; siteKey: string } | null;
  whatsapp: { token: string; phoneNumberId: string } | null;
  email: { apiKey: string; from: string } | null;
  alertEmail: string | null;
  caps: { perRecipientPerDay: number; globalPerDay: number };
  /** Canales con proveedor real; en desarrollo y tests, la consola cubre los que falten. */
  channels: NotificationChannel[];
  /** Se está usando algo de desarrollo (secretos fijos, verificador falso o consola). */
  devFallbacks: boolean;
}

export interface Readiness {
  ready: boolean;
  /** Lo que falta o viene mal (nombres de variables, nunca valores). */
  missing: string[];
  channels: NotificationChannel[];
  devFallbacks: boolean;
}

function evaluate(): { config: PublicConfig; missing: string[] } {
  const { values: v, problems } = publicEnv();
  const missing = [...problems];
  const need = (name: string, value: unknown) => {
    if (value === undefined && !problems.some((p) => p.startsWith(name))) missing.push(name);
  };
  need("OTP_PEPPER", v.OTP_PEPPER);
  need("MANAGE_LINK_SECRET", v.MANAGE_LINK_SECRET);
  need("PUBLIC_BASE_URL", v.PUBLIC_BASE_URL);
  need("TURNSTILE_SECRET", v.TURNSTILE_SECRET);
  need("NEXT_PUBLIC_TURNSTILE_SITE_KEY", v.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const whatsapp = v.WHATSAPP_TOKEN && v.WHATSAPP_PHONE_NUMBER_ID ? { token: v.WHATSAPP_TOKEN, phoneNumberId: v.WHATSAPP_PHONE_NUMBER_ID } : null;
  const email = v.RESEND_API_KEY && v.EMAIL_FROM ? { apiKey: v.RESEND_API_KEY, from: v.EMAIL_FROM } : null;
  const real: NotificationChannel[] = [...(whatsapp ? (["whatsapp"] as const) : []), ...(email ? (["email"] as const) : [])];
  // El código sale SOLO por WhatsApp: es lo que prueba que el celular es de quien reserva.
  // El correo queda para avisos (confirmación, recordatorios), nunca para el código.
  if (!whatsapp && !problems.some((p) => p.startsWith("WHATSAPP"))) missing.push("WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID");

  const turnstile = v.TURNSTILE_SECRET && v.NEXT_PUBLIC_TURNSTILE_SITE_KEY ? { secret: v.TURNSTILE_SECRET, siteKey: v.NEXT_PUBLIC_TURNSTILE_SITE_KEY } : null;
  const dev = allowsDevFallbacks();
  const devFallbacks = dev && (!v.OTP_PEPPER || !v.MANAGE_LINK_SECRET || !v.PUBLIC_BASE_URL || !turnstile || !whatsapp || !email);

  return {
    missing,
    config: {
      otpPepper: v.OTP_PEPPER ?? (dev ? DEV_ONLY_OTP_PEPPER : ""),
      manageLinkSecret: v.MANAGE_LINK_SECRET ?? (dev ? DEV_ONLY_MANAGE_LINK_SECRET : ""),
      baseUrl: v.PUBLIC_BASE_URL ?? (dev ? DEV_BASE_URL : ""),
      turnstile,
      whatsapp,
      email,
      alertEmail: v.ALERT_EMAIL ?? null,
      caps: {
        perRecipientPerDay: v.NOTIFY_CAP_PHONE ?? DEFAULT_CAPS.perRecipientPerDay,
        globalPerDay: v.NOTIFY_CAP_GLOBAL ?? DEFAULT_CAPS.globalPerDay,
      },
      channels: dev ? ["whatsapp", "email"] : real,
      devFallbacks,
    },
  };
}

export function publicBookingReadiness(): Readiness {
  const { config, missing } = evaluate();
  // En desarrollo y tests siempre está lista (con lo de desarrollo); `missing` queda como información.
  return { ready: allowsDevFallbacks() ? true : missing.length === 0, missing, channels: config.channels, devFallbacks: config.devFallbacks };
}

export class PublicBookingUnavailableError extends Error {
  constructor() {
    super("La reserva en línea no está disponible en este momento. Llámanos o escríbenos por WhatsApp.");
    this.name = "PublicBookingUnavailableError";
  }
}

/** La configuración lista para usar; lanza si falta algo fuera de desarrollo y tests (falla cerrado). */
export function publicConfig(): PublicConfig {
  const { config, missing } = evaluate();
  if (!allowsDevFallbacks() && missing.length > 0) throw new PublicBookingUnavailableError();
  return config;
}

/** HMAC-SHA256 hex: cubetas de límites y hashes de destinatarios. Sin next/headers (lo usa el worker). */
export function bucketHash(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}
