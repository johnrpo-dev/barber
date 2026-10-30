"use client";

import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button, FieldError, Label, ListBox, ListBoxItem, Popover, Select, SelectValue, Text } from "react-aria-components";
import { cx, field } from "./ui";

// Lista desplegable con la piel del panel (react-aria Select: teclado, lector y táctil).

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
  isDisabled?: boolean;
}

export function SelectField({
  label,
  options,
  value,
  onChange,
  name,
  placeholder = "Elige una opción",
  description,
  error,
  isRequired,
  isDisabled,
  className,
}: {
  label: ReactNode;
  options: SelectOption[];
  value: string | null;
  onChange: (id: string) => void;
  name?: string;
  placeholder?: string;
  description?: ReactNode;
  error?: string | null;
  isRequired?: boolean;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      name={name}
      value={value}
      onChange={(key) => key !== null && onChange(String(key))}
      placeholder={placeholder}
      isRequired={isRequired}
      isInvalid={!!error}
      isDisabled={isDisabled}
      disabledKeys={options.filter((o) => o.isDisabled).map((o) => o.id)}
      className={cx(field.root, className)}
    >
      <Label className={field.label}>{label}</Label>
      <Button
        className={cx(
          field.input,
          "flex items-center justify-between gap-2 text-left outline-none data-[disabled]:opacity-60",
          "data-[focus-visible]:outline-3 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-cuero",
          error && "border-alerta",
        )}
      >
        <SelectValue className="min-w-0 flex-1 truncate data-[placeholder]:text-tinta/60" />
        <ChevronDown size={18} className="shrink-0 text-tinta/70" aria-hidden />
      </Button>
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={field.error}>{error}</FieldError>
      <Popover className="min-w-[--trigger-width] max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-tinta/10 bg-papel p-1 shadow-xl data-[entering]:animate-pop-in">
        <ListBox className="max-h-72 outline-none">
          {options.map((o) => (
            <ListBoxItem
              key={o.id}
              id={o.id}
              textValue={o.label}
              className={({ isFocused, isSelected, isDisabled: off }) =>
                cx(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none",
                  isFocused && "bg-tinta/5",
                  isSelected && "font-semibold",
                  off && "cursor-default opacity-50",
                )
              }
            >
              {({ isSelected }) => (
                <>
                  <span className="grid w-4 shrink-0 place-items-center" aria-hidden>
                    {isSelected ? <Check size={16} className="text-cuero" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.description ? <span className="text-xs font-normal text-tinta/70">{o.description}</span> : null}
                  </span>
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
