import { z } from "zod";
import { BookingError } from "@/domain/booking/appointment";
import { TransitionError } from "@/domain/booking/status";
import { InvalidServiceError } from "@/domain/catalog/service";
import { InvalidClientError } from "@/domain/clients/client";
import { InvalidScheduleError } from "@/domain/staff/schedule";
import { SlotTakenError } from "@/db/appointments";
import { StaffError } from "@/db/staff";

// Resultado de toda server action: nunca se lanza al cliente un error técnico.
// Los errores de negocio llevan su mensaje (en español); el resto se registra y se generaliza.

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const BUSINESS_ERRORS = [
  BookingError,
  SlotTakenError,
  TransitionError,
  InvalidServiceError,
  InvalidClientError,
  InvalidScheduleError,
  StaffError,
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

/** Lo mínimo para diagnosticar sin volcar los parámetros de la consulta (hashes, celulares). */
function describeError(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const { name, message, code, constraint_name, constraint } = e as Record<string, unknown>;
    out[`level${depth}`] = {
      name,
      code,
      constraint: constraint_name ?? constraint,
      message: typeof message === "string" ? message.split(/\nparams:|params:/)[0]?.slice(0, 300) : undefined,
    };
  }
  return out;
}

/** IDs internos viajan al panel como texto; aquí se validan y vuelven a bigint. */
export const idSchema = z
  .string()
  .regex(/^\d{1,18}$/, "Identificador inválido")
  .transform((v) => BigInt(v));
