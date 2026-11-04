"use client";

import { type CalendarDate, parseDate } from "@internationalized/date";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Label,
  Popover,
  Text,
} from "react-aria-components";
import { FieldMessage } from "../_manage/controls";
import { cx, field } from "./ui";

// Fecha de calendario ("yyyy-MM-dd") con el DatePicker de react-aria: se escribe por segmentos
// (día, mes, año) o se elige en el calendario. Entra y sale como texto; nunca como Date.

const toDate = (value: string | null | undefined): CalendarDate | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return parseDate(value);
  } catch {
    return null;
  }
};

export function DateField({
  label,
  value,
  onChange,
  min,
  max,
  name,
  description,
  error,
  isRequired,
  isDisabled,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (date: string) => void;
  min?: string | null;
  max?: string | null;
  name?: string;
  description?: ReactNode;
  error?: string | null;
  isRequired?: boolean;
  isDisabled?: boolean;
  className?: string;
}) {
  const minValue = toDate(min) ?? undefined;
  const maxValue = toDate(max) ?? undefined;
  return (
    <DatePicker
      name={name}
      value={toDate(value)}
      onChange={(d) => onChange(d ? d.toString() : "")}
      minValue={minValue}
      maxValue={maxValue}
      isRequired={isRequired}
      isInvalid={!!error}
      isDisabled={isDisabled}
      granularity="day"
      className={cx(field.root, className)}
    >
      <Label className={field.label}>{label}</Label>
      <Group
        className={cx(
          "flex h-12 w-full items-center rounded-lg border border-tinta/50 bg-papel pl-3 text-base text-tinta",
          "data-[focus-within]:border-cuero data-[invalid]:border-alerta data-[disabled]:opacity-60",
        )}
      >
        <DateInput className="monto flex min-w-0 flex-1 items-center">
          {(segment) => (
            <DateSegment
              segment={segment}
              className={cx(
                "rounded px-0.5 outline-none tabular-nums",
                "data-[placeholder]:text-tinta/60 data-[type=literal]:px-0 data-[type=literal]:text-tinta/60",
                "data-[focused]:bg-cuero data-[focused]:text-hueso",
              )}
            />
          )}
        </DateInput>
        <Button
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-tinta/70 outline-none hover:bg-tinta/5 data-[focus-visible]:outline-3 data-[focus-visible]:outline-cuero"
          aria-label="Abrir calendario"
        >
          <CalendarDays size={18} aria-hidden />
        </Button>
      </Group>
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
      <FieldMessage>{error}</FieldMessage>
      <Popover className="rounded-2xl border border-tinta/10 bg-papel p-3 shadow-xl data-[entering]:animate-pop-in">
        <Dialog className="outline-none">
          <Calendar>
            <header className="mb-2 flex items-center justify-between">
              <Button slot="previous" className="grid h-10 w-10 place-items-center rounded-lg hover:bg-tinta/5 data-[disabled]:opacity-30" aria-label="Mes anterior">
                <ChevronLeft size={18} aria-hidden />
              </Button>
              <Heading className="font-semibold capitalize" />
              <Button slot="next" className="grid h-10 w-10 place-items-center rounded-lg hover:bg-tinta/5 data-[disabled]:opacity-30" aria-label="Mes siguiente">
                <ChevronRight size={18} aria-hidden />
              </Button>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5">
              {(d) => (
                <CalendarCell
                  date={d}
                  className={({ isSelected, isOutsideMonth, isFocusVisible, isDisabled: off, isUnavailable }) =>
                    cx(
                      "monto grid h-10 w-10 cursor-pointer place-items-center rounded-lg text-sm",
                      isOutsideMonth && "invisible",
                      isSelected ? "bg-cuero font-semibold text-hueso" : "hover:bg-tinta/5",
                      (off || isUnavailable) && "cursor-default text-tinta/30 line-through hover:bg-transparent",
                      isFocusVisible && "outline-3 outline-offset-1 outline-cuero",
                    )
                  }
                />
              )}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DatePicker>
  );
}
