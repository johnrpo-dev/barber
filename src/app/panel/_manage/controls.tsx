"use client";

import { Minus, Plus } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Button, FieldError, Group, Input, Label, NumberField, Switch, Text } from "react-aria-components";
import { cx, field } from "../_components/ui";

// Controles de las pantallas de gestión del dueño (servicios y personal), con la piel de ui.tsx.
// Candidatos a subir a _components/ui.tsx cuando otra pantalla los necesite.

export const card = "rounded-xl border border-tinta/10 bg-papel";

/** Interruptor accesible: el estado se dice en texto, no solo con color. */
export function Toggle({
  isSelected,
  onChange,
  children,
  isDisabled,
  className,
  "aria-label": ariaLabel,
}: {
  isSelected: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
  isDisabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      aria-label={ariaLabel}
      className={cx(
        "group inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-tinta outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "flex h-7 w-12 shrink-0 items-center rounded-full bg-tinta/50 p-0.5 transition-colors duration-150",
          "group-data-[selected]:bg-botella",
          "group-data-[focus-visible]:outline-3 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-cuero",
        )}
      >
        <span className="block h-6 w-6 rounded-full bg-papel shadow-sm transition-transform duration-150 ease-[var(--ease-villa)] group-data-[selected]:translate-x-5" />
      </span>
      {children}
    </Switch>
  );
}

const CHIP_TONES = {
  neutral: "border-tinta/15 bg-hueso text-tinta/80",
  success: "border-botella/25 bg-botella/10 text-botella",
  muted: "border-tinta/10 bg-tinta/5 text-tinta/70",
  primary: "border-cuero/25 bg-cuero/10 text-cuero",
} as const;

export function Chip({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: keyof typeof CHIP_TONES;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold",
        CHIP_TONES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Minutos enteros con botones − / + de 44 px (la duración no es dinero: number está bien aquí). */
export function MinutesField({
  label,
  value,
  onChange,
  minValue,
  maxValue,
  description,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  minValue: number;
  maxValue: number;
  description?: string;
}) {
  return (
    <NumberField
      value={value}
      onChange={(v) => onChange(Number.isNaN(v) ? minValue : v)}
      minValue={minValue}
      maxValue={maxValue}
      step={5}
      formatOptions={{ maximumFractionDigits: 0 }}
      className={field.root}
    >
      <Label className={field.label}>{label}</Label>
      <Group className="flex h-12 items-stretch overflow-hidden rounded-lg border border-tinta/50 bg-papel data-[focus-within]:border-cuero data-[focus-within]:outline-3 data-[focus-within]:outline-offset-2 data-[focus-within]:outline-cuero">
        <Button
          slot="decrement"
          className="grid w-11 shrink-0 place-items-center text-tinta/70 outline-none hover:bg-tinta/5 data-[disabled]:opacity-30 data-[focus-visible]:bg-tinta/10"
        >
          <Minus size={18} aria-hidden />
        </Button>
        <Input className="monto min-w-0 flex-1 bg-transparent text-center text-base text-tinta outline-none" />
        <Button
          slot="increment"
          className="grid w-11 shrink-0 place-items-center text-tinta/70 outline-none hover:bg-tinta/5 data-[disabled]:opacity-30 data-[focus-visible]:bg-tinta/10"
        >
          <Plus size={18} aria-hidden />
        </Button>
      </Group>
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
    </NumberField>
  );
}

/** Error del formulario, anunciado al lector de pantalla. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className={cx(field.error, !message && "sr-only")}>
      {message}
    </p>
  );
}

/** Mensaje de error de un campo (dentro de su TextField, que debe llevar isInvalid). */
export function FieldMessage({ children }: { children: ReactNode }) {
  return <FieldError className={field.error}>{children}</FieldError>;
}

/**
 * Errores por campo. `check` recibe los errores encontrados, los guarda y lleva el foco al primer
 * campo inválido (por su atributo name); devuelve true si no hay ninguno.
 */
export function useFieldErrors<K extends string>() {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});
  const check = useCallback((form: HTMLFormElement, found: Partial<Record<K, string>>) => {
    setErrors(found);
    const first = Object.keys(found)[0];
    if (!first) return true;
    form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    return false;
  }, []);
  const clear = useCallback((key: K) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e)), []);
  return { errors, check, clear };
}

/** Opción de un grupo de radios con aspecto de tarjeta seleccionable. */
export const radioCard = cx(
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-tinta/15 bg-papel px-3 py-2.5 text-sm font-medium outline-none transition-colors",
  "data-[selected]:border-cuero data-[selected]:bg-cuero/5",
  "data-[focus-visible]:outline-3 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-cuero",
);

/** Punto del radio: relleno cuando está elegido (además del borde, no solo color). */
export function RadioDot() {
  return (
    <span
      aria-hidden
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-tinta/50 group-data-[selected]:border-cuero"
    >
      <span className="h-2.5 w-2.5 scale-0 rounded-full bg-cuero transition-transform group-data-[selected]:scale-100" />
    </span>
  );
}
