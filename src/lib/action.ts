import { z } from "zod";
import { BookingError } from "@/domain/booking/appointment";
import { TransitionError } from "@/domain/booking/status";
import { InvalidServiceError } from "@/domain/catalog/service";
import { InvalidClientError } from "@/domain/clients/client";
import { CashError } from "@/domain/sales/cash";
import { CheckoutError } from "@/domain/sales/checkout";
import { VoidError } from "@/domain/sales/void";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { ReauthRequiredError } from "@/domain/security/reauth";
import { InvalidScheduleError } from "@/domain/staff/schedule";
import { SlotTakenError } from "@/db/appointments";
import { AccountLockedError } from "@/db/login-throttle";
import { RateLimitError } from "@/db/rate-limit";
import { StaffError } from "@/db/staff";
import { describeError } from "./log";
import { PublicBookingUnavailableError } from "./public-readiness";

// Resultado de toda server action: nunca se lanza al cliente un error técnico.
// Los errores de negocio llevan su mensaje (en español); el resto se registra y se generaliza.

// Los mensajes de validación por defecto de zod salen en español (los propios ya lo están).
z.config(z.locales.es());

/**
 * `code: "reauth_required"`: la acción es crítica y la sesión no confirmó identidad hace poco;
 * la interfaz pide la contraseña o el código y reintenta (ver ReauthDialog).
 */
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: "reauth_required" };

const BUSINESS_ERRORS = [
  IdempotencyConflictError,
  AccountLockedError,
  BookingError,
  SlotTakenError,
  TransitionError,
  InvalidServiceError,
  InvalidClientError,
  InvalidScheduleError,
  StaffError,
  RateLimitError,
  PublicBookingUnavailableError,
  CheckoutError,
  CashError,
  VoidError,
];

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ReauthRequiredError) return { ok: false, error: err.message, code: err.code };
    if (BUSINESS_ERRORS.some((E) => err instanceof E)) return { ok: false, error: (err as Error).message };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Datos inválidos" };
    // redirect()/notFound() de Next.js se propagan tal cual.
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) throw err;
    console.error("[action]", describeError(err));
    return { ok: false, error: "No se pudo completar. Intenta de nuevo." };
  }
}

/** IDs internos viajan al panel como texto; aquí se validan y vuelven a bigint. */
export const idSchema = z
  .string()
  .regex(/^\d{1,18}$/, "Identificador inválido")
  .transform((v) => BigInt(v));
