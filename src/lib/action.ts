import { z } from "zod";
import { BookingError } from "@/domain/booking/appointment";
import { TransitionError } from "@/domain/booking/status";
import { InvalidServiceError } from "@/domain/catalog/service";
import { InvalidClientError } from "@/domain/clients/client";
import { InvalidScheduleError } from "@/domain/staff/schedule";
import { SlotTakenError } from "@/db/appointments";
import { RateLimitError } from "@/db/rate-limit";
import { StaffError } from "@/db/staff";
import { describeError } from "./log";
import { PublicBookingUnavailableError } from "./public-readiness";

// Resultado de toda server action: nunca se lanza al cliente un error técnico.
// Los errores de negocio llevan su mensaje (en español); el resto se registra y se generaliza.

// Los mensajes de validación por defecto de zod salen en español (los propios ya lo están).
z.config(z.locales.es());

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const BUSINESS_ERRORS = [
  BookingError,
  SlotTakenError,
  TransitionError,
  InvalidServiceError,
  InvalidClientError,
  InvalidScheduleError,
  StaffError,
  RateLimitError,
  PublicBookingUnavailableError,
];

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
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
