import { z } from "zod";
import { fromUnits, type Money } from "@/domain/money";

// Esquemas compartidos por las acciones de dinero (docs/sprint-4-cobro-caja.md §9). El dinero que
// entra viaja como texto de pesos enteros ("30000") y los puntos básicos como texto de dígitos
// ("299"): se validan aquí y pasan a bigint sin tocar nunca `number`.

/** Pesos enteros en texto → Money. Tope: $100.000 millones (10^11 pesos). */
export const unitsSchema = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, `${label}: escribe el valor en pesos, sin puntos ni centavos`)
    .transform((v): Money => fromUnits(BigInt(v)))
    .refine((m) => m.minor <= 10n ** 13n, `${label} es demasiado grande`);

/** Puntos básicos en texto de dígitos → bigint, dentro del rango. */
export const bpsSchema = (label: string, max: bigint) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, `${label}: valor inválido`)
    .transform((v) => BigInt(v))
    .refine((v) => v <= max, `${label} está fuera del rango permitido`);

/** Clave de idempotencia: el formId del formulario, estable entre reintentos de red. */
export const idempotencyKeySchema = z.string().min(8, "Formulario inválido; recarga la pantalla").max(100, "Formulario inválido");

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida");
