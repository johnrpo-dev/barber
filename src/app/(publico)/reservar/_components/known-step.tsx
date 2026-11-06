"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";
import { Btn, cx, field } from "@/app/panel/_components/ui";
import type { KnownClientView } from "../../data";
import { ConsentBox, DataProcessingConsentText } from "./details-step";
import { useTurnstile } from "./turnstile";

// Paso "Confirmar" para quien ya verificó su celular en este navegador: sin formulario ni
// código, un toque y la cita queda confirmada. "No soy yo" olvida el navegador y vuelve al
// formulario de siempre. Si autorizó con una política anterior, pide una vez la casilla de la
// vigente (el mismo texto del formulario); sin ella no se reserva (sprint 7).

export function KnownStep({
  known,
  onConfirm,
  onNotMe,
  pending,
  serverError,
  turnstileSiteKey,
}: {
  known: KnownClientView;
  onConfirm: (turnstileToken: string, acceptsPolicy: boolean) => Promise<void>;
  onNotMe: () => void;
  pending: boolean;
  serverError: string | null;
  turnstileSiteKey: string | null;
}) {
  const { widget, getToken } = useTurnstile(turnstileSiteKey);
  const [checking, setChecking] = useState(false);
  const [humanError, setHumanError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  async function confirm() {
    if (pending || checking) return;
    setHumanError(null);
    if (known.needsConsent && !accepted) {
      setConsentError("Para reservar en línea necesitamos tu autorización para tratar tus datos.");
      return;
    }
    setChecking(true);
    let token: string;
    try {
      token = await getToken();
    } catch {
      setChecking(false);
      setHumanError("No pudimos comprobar que eres una persona. Recarga la página e inténtalo otra vez.");
      return;
    }
    setChecking(false);
    await onConfirm(token, known.needsConsent && accepted);
  }

  const error = humanError ?? serverError;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-xl border border-tinta/10 bg-papel p-4">
        <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-botella text-hueso">
          <UserRound size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Reservas como {known.firstName}</span>
          <span className="monto block text-sm text-tinta/70">Celular {known.maskedPhone}</span>
        </span>
      </div>

      {known.needsConsent ? (
        <fieldset className="flex flex-col gap-2 rounded-xl border border-tinta/10 bg-papel p-4">
          <legend className="px-1 text-sm font-semibold">Autorización actualizada</legend>
          <p className="text-sm text-tinta/80">Actualizamos nuestra política de datos. Para seguir reservando, confírmanos tu autorización una vez.</p>
          <ConsentBox
            name="dataProcessing"
            isSelected={accepted}
            onChange={(on) => {
              setAccepted(on);
              setConsentError(null);
            }}
            isInvalid={!!consentError}
            isRequired
            errorId="error-known-consent"
          >
            <DataProcessingConsentText />
          </ConsentBox>
          {consentError ? (
            <p id="error-known-consent" className={cx(field.error, "pl-9")}>
              {consentError}
            </p>
          ) : null}
          <p className="pt-1 text-sm text-tinta/70">
            Lee nuestra{" "}
            <a href="/privacidad" target="_blank" rel="noopener" className="font-semibold text-cuero underline underline-offset-4">
              política de privacidad<span className="sr-only"> (se abre en otra pestaña)</span>
            </a>
            .
          </p>
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl border border-alerta/30 bg-alerta/5 p-4 text-sm font-medium text-alerta">
          {error}
        </p>
      ) : null}

      {widget}

      <Btn size="xl" className="w-full" isPending={pending || checking} onPress={confirm}>
        {pending || checking ? "Confirmando…" : "Confirmar reserva"}
      </Btn>
      <Btn variant="ghost" onPress={onNotMe} className="-ml-1 self-start">
        No soy {known.firstName}
      </Btn>
    </div>
  );
}
