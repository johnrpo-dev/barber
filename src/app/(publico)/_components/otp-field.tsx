"use client";

import type { Ref } from "react";
import { Input, Label, Text, TextField } from "react-aria-components";
import { field } from "@/app/panel/_components/ui";
import { FieldMessage } from "@/app/panel/_manage/controls";

// Código de 6 dígitos en UN solo input (no seis cajas): autocompletar del SMS/WhatsApp, pegar y
// los lectores de pantalla funcionan sin trucos. Se envía solo al completar los 6 dígitos.

export function OtpField({
  value,
  onChange,
  onComplete,
  description,
  error,
  isDisabled,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete: (code: string) => void;
  description: string;
  error: string | null;
  isDisabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <TextField
      name="code"
      value={value}
      onChange={(raw) => {
        // Se aceptan pegados como "123 456" o "123-456": solo cuentan los dígitos.
        const digits = raw.replace(/\D/g, "").slice(0, 6);
        onChange(digits);
        if (digits.length === 6 && digits !== value) onComplete(digits);
      }}
      isInvalid={!!error}
      isDisabled={isDisabled}
      validationBehavior="aria"
      className={field.root}
    >
      <Label className={field.label}>Código de 6 dígitos</Label>
      <Input
        ref={inputRef}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        className="monto h-16 w-full max-w-[16rem] rounded-xl border-2 border-tinta/50 bg-papel text-center indent-[0.5em] font-display text-4xl tracking-[0.5em] text-tinta outline-none transition-colors focus:border-cuero data-[focus-visible]:outline-3 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-cuero data-[disabled]:opacity-50 data-[invalid]:border-alerta"
      />
      <Text slot="description" className="text-sm text-tinta/70">
        {description}
      </Text>
      <FieldMessage>{error}</FieldMessage>
    </TextField>
  );
}
