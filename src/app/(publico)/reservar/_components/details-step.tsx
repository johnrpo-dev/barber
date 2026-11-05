"use client";

import { Check } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Checkbox, Form, Input, Label, Text, TextField } from "react-aria-components";
import { Btn, cx, field } from "@/app/panel/_components/ui";
import { FieldMessage, useFieldErrors } from "@/app/panel/_manage/controls";
import { ErrorSummary, type SummaryItem } from "../../_components/error-summary";
import { formatPhone, phoneDigits } from "../../_lib/ui";
import { useTurnstile } from "./turnstile";
import { BUSINESS_NAME } from "@/domain/brand";

// Paso "Tus datos": a la vista solo nombre, celular y la autorización obligatoria (Ley 1581); el
// correo y las promociones esperan en "Más opciones". Ninguna casilla viene marcada. El único
// recordatorio (unas 3 h antes, si reservó con más de 6 h) va dentro de la autorización obligatoria:
// es parte de gestionar la cita, no publicidad (veredicto del council, sprint 6). "Recibir código" corre Turnstile y entrega el token al flujo, que crea la retención.
// Es la única vez: después este navegador queda recordado y no se vuelve a pedir.

export interface Details {
  name: string;
  phone: string;
  email: string;
  consents: { dataProcessing: boolean; reminders: boolean; marketing: boolean };
}

type FieldName = "name" | "phone" | "email" | "dataProcessing";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(v: Details): Partial<Record<FieldName, string>> {
  const found: Partial<Record<FieldName, string>> = {};
  if (v.name.trim().length < 2) found.name = "Escribe tu nombre.";
  const digits = phoneDigits(v.phone);
  if (!digits) found.phone = "Escribe tu celular.";
  else if (!/^3\d{9}$/.test(digits)) found.phone = "El celular debe tener 10 dígitos y empezar por 3.";
  if (v.email.trim() && !EMAIL.test(v.email.trim())) found.email = "Revisa el correo; por ejemplo, nombre@correo.com.";
  if (!v.consents.dataProcessing) found.dataProcessing = "Para reservar en línea necesitamos tu autorización para tratar tus datos.";
  return found;
}

export function DetailsStep({
  value,
  onChange,
  onSubmit,
  pending,
  serverError,
  turnstileSiteKey,
}: {
  value: Details;
  onChange: (patch: Partial<Details>) => void;
  onSubmit: (turnstileToken: string) => Promise<void>;
  pending: boolean;
  /** Error del servidor; `seq` cambia en cada envío para volver a enfocar el resumen. */
  serverError: { message: string; seq: number } | null;
  turnstileSiteKey: string | null;
}) {
  const { errors, check, clear } = useFieldErrors<FieldName>();
  const [humanError, setHumanError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const { widget, getToken } = useTurnstile(turnstileSiteKey);
  const [more, setMore] = useState(() => !!value.email || value.consents.marketing);

  const items: SummaryItem[] = [
    ...(["name", "phone", "email", "dataProcessing"] as const).flatMap((name) => (errors[name] ? [{ name, message: errors[name] }] : [])),
    ...(humanError ? [{ message: humanError }] : []),
    ...(serverError ? [{ message: serverError.message }] : []),
  ];
  const hasItems = items.length > 0;

  // Tras un envío con errores, el foco va al resumen (que enlaza a cada campo).
  useEffect(() => {
    if (attempt > 0 && hasItems) summaryRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, serverError?.seq]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || checking) return;
    setHumanError(null);
    const valid = check(e.currentTarget, validate(value));
    setAttempt((n) => n + 1);
    if (!valid) {
      if (errors.email || validate(value).email) setMore(true);
      return;
    }
    setChecking(true);
    let token: string;
    try {
      token = await getToken();
    } catch {
      setChecking(false);
      setHumanError("No pudimos comprobar que eres una persona. Recarga la página e inténtalo otra vez.");
      setAttempt((n) => n + 1);
      return;
    }
    setChecking(false);
    await onSubmit(token);
  }

  const setConsent = (key: keyof Details["consents"], on: boolean) => onChange({ consents: { ...value.consents, [key]: on } });

  return (
    <Form onSubmit={submit} validationBehavior="aria" className="flex flex-col gap-5" aria-label="Tus datos">
      <ErrorSummary ref={summaryRef} items={items} />

      <TextField
        name="name"
        autoComplete="name"
        value={value.name}
        onChange={(v) => {
          onChange({ name: v });
          clear("name");
        }}
        isInvalid={!!errors.name}
        isRequired
        maxLength={80}
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} />
        <FieldMessage>{errors.name}</FieldMessage>
      </TextField>

      <TextField
        name="phone"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={value.phone}
        onChange={(v) => {
          onChange({ phone: v });
          clear("phone");
        }}
        onBlur={() => onChange({ phone: formatPhone(value.phone) })}
        isInvalid={!!errors.phone}
        isRequired
        maxLength={20}
        className={field.root}
      >
        <Label className={field.label}>Celular</Label>
        <div className="relative">
          <span aria-hidden className="monto pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-tinta/70">
            +57
          </span>
          <Input className={cx(field.input, "monto pl-12")} />
        </div>
        <Text slot="description" className={field.description}>
          Celular de 10 dígitos (+57). Ahí te llega el código por WhatsApp.
        </Text>
        <FieldMessage>{errors.phone}</FieldMessage>
      </TextField>


      <fieldset className="flex flex-col gap-2 rounded-xl border border-tinta/10 bg-papel p-4">
        <legend className="px-1 text-sm font-semibold">Autorizaciones</legend>
        <ConsentBox
          name="dataProcessing"
          isSelected={value.consents.dataProcessing}
          onChange={(on) => {
            setConsent("dataProcessing", on);
            clear("dataProcessing");
          }}
          isInvalid={!!errors.dataProcessing}
          isRequired
          errorId="error-dataProcessing"
        >
          Autorizo a {BUSINESS_NAME} a tratar mis datos para gestionar mi cita y a escribirme para confirmarla y recordármela ese
          mismo día. <span className="text-tinta/70">(Obligatoria)</span>
        </ConsentBox>
        {errors.dataProcessing ? (
          <p id="error-dataProcessing" className={cx(field.error, "pl-9")}>
            {errors.dataProcessing}
          </p>
        ) : null}
        <p className="pt-1 text-sm text-tinta/70">
          Puedes cambiar esto cuando quieras. Lee nuestra{" "}
          <a href="/privacidad" target="_blank" rel="noopener" className="font-semibold text-cuero underline underline-offset-4">
            política de privacidad<span className="sr-only"> (se abre en otra pestaña)</span>
          </a>
          .
        </p>
      </fieldset>

      <div className="flex flex-col gap-4">
        <button
          type="button"
          aria-expanded={more}
          aria-controls="mas-opciones"
          onClick={() => setMore((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-cuero underline-offset-4 hover:underline"
        >
          Más opciones (correo y promociones)
          <ChevronDown size={16} aria-hidden className={cx("transition-transform", more && "rotate-180")} />
        </button>
        <div id="mas-opciones" hidden={!more} className="flex flex-col gap-4">
          <TextField
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={value.email}
            onChange={(v) => {
              onChange({ email: v });
              clear("email");
            }}
            isInvalid={!!errors.email}
            maxLength={120}
            className={field.root}
          >
            <Label className={field.label}>Correo (opcional)</Label>
            <Input className={field.input} />
            <FieldMessage>{errors.email}</FieldMessage>
          </TextField>
          <ConsentBox name="marketing" isSelected={value.consents.marketing} onChange={(on) => setConsent("marketing", on)}>
            Quiero recibir promociones y novedades de {BUSINESS_NAME}.
          </ConsentBox>
        </div>
      </div>

      {widget}

      <Btn type="submit" size="xl" className="w-full" isPending={pending || checking}>
        {pending || checking ? "Enviando código…" : "Recibir código por WhatsApp"}
      </Btn>
    </Form>
  );
}

function ConsentBox({
  name,
  isSelected,
  onChange,
  isInvalid,
  isRequired,
  errorId,
  children,
}: {
  name: string;
  isSelected: boolean;
  onChange: (on: boolean) => void;
  isInvalid?: boolean;
  isRequired?: boolean;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <Checkbox
      name={name}
      isSelected={isSelected}
      onChange={onChange}
      isInvalid={isInvalid}
      isRequired={isRequired}
      aria-describedby={isInvalid ? errorId : undefined}
      className="group flex min-h-11 cursor-pointer items-start gap-3 py-1.5 text-sm leading-snug outline-none"
    >
      <span
        aria-hidden
        className={cx(
          "grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-tinta/50 bg-papel transition-colors",
          "group-data-[selected]:border-cuero group-data-[selected]:bg-cuero group-data-[invalid]:border-alerta",
          "group-data-[focus-visible]:outline-3 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-cuero",
        )}
      >
        <Check size={16} strokeWidth={3} className="text-hueso opacity-0 group-data-[selected]:opacity-100" />
      </span>
      <span className="pt-0.5">{children}</span>
    </Checkbox>
  );
}
