"use client";

import type { ReactNode } from "react";
import { Input, Label, Text, TextField } from "react-aria-components";
import type { ActionResult } from "@/lib/action";
import { FieldMessage } from "../_manage/controls";
import { cx, field } from "./ui";

// Dinero que se escribe en el panel: pesos enteros como texto ("30000"), nunca number.
// Se convierte con BigInt solo después de comprobar que son dígitos (CLAUDE.md, reglas de dinero).

/** Deja solo dígitos, sin ceros a la izquierda y con un largo sano (hasta $99.999.999.999). */
export function onlyDigits(value: string, maxLength = 11): string {
  return value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, maxLength);
}

/** "35000" → "35.000". Es manejo de texto: el monto nunca pasa por number. */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Pesos enteros escritos → bigint (0n si está vacío). */
export function unitsOf(digits: string): bigint {
  return /^\d+$/.test(digits) ? BigInt(digits) : 0n;
}

/** 299n → "2,99"; 3000n → "30". Los puntos básicos son enteros, no dinero. */
export function bpsToPercentText(bps: bigint | string): string {
  const v = typeof bps === "string" ? (/^\d+$/.test(bps) ? BigInt(bps) : 0n) : bps;
  const whole = v / 100n;
  const fraction = (v % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : whole.toString();
}

/** "2,99" o "2.99" → 299n; null si no es un porcentaje con hasta 2 decimales. Solo manejo de texto. */
export function percentTextToBps(text: string): bigint | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

/** Clave de idempotencia de un formulario (el formId del contrato). */
export const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const NETWORK_ERROR = "No hay conexión con el servidor. Revisa el internet e intenta de nuevo: no se registró dos veces.";

/**
 * Llama una server action y distingue un fallo de red (la clave de idempotencia se conserva para
 * reintentar) de una respuesta del servidor (la clave se renueva).
 */
export async function callAction<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T> & { network?: boolean }> {
  try {
    return await fn();
  } catch {
    return { ok: false, error: NETWORK_ERROR, network: true };
  }
}

/** Campo de pesos enteros con separador de miles y "$" delante. */
export function MoneyField({
  label,
  value,
  onChange,
  name,
  error,
  description,
  isRequired,
  autoFocus,
  isDisabled,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: {
  label?: ReactNode;
  value: string;
  onChange: (digits: string) => void;
  name?: string;
  error?: string | null;
  description?: ReactNode;
  isRequired?: boolean;
  autoFocus?: boolean;
  isDisabled?: boolean;
  className?: string;
  size?: "md" | "lg";
  "aria-label"?: string;
}) {
  return (
    <TextField
      name={name}
      value={groupThousands(value)}
      onChange={(v) => onChange(onlyDigits(v))}
      isRequired={isRequired}
      isInvalid={!!error}
      isDisabled={isDisabled}
      inputMode="numeric"
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      className={cx(field.root, className)}
    >
      {label ? <Label className={field.label}>{label}</Label> : null}
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-tinta/70">
          $
        </span>
        <Input
          className={cx(field.input, "monto pl-7 data-[disabled]:opacity-60", size === "lg" && "h-14 text-xl font-semibold")}
          placeholder="0"
          autoComplete="off"
        />
      </div>
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
      <FieldMessage>{error}</FieldMessage>
    </TextField>
  );
}
