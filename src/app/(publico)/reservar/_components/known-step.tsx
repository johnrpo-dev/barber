"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";
import { Btn } from "@/app/panel/_components/ui";
import type { KnownClientView } from "../../data";
import { useTurnstile } from "./turnstile";

// Paso "Confirmar" para quien ya verificó su celular en este navegador: sin formulario ni
// código, un toque y la cita queda confirmada. "No soy yo" olvida el navegador y vuelve al
// formulario de siempre.

export function KnownStep({
  known,
  onConfirm,
  onNotMe,
  pending,
  serverError,
  turnstileSiteKey,
}: {
  known: KnownClientView;
  onConfirm: (turnstileToken: string) => Promise<void>;
  onNotMe: () => void;
  pending: boolean;
  serverError: string | null;
  turnstileSiteKey: string | null;
}) {
  const { widget, getToken } = useTurnstile(turnstileSiteKey);
  const [checking, setChecking] = useState(false);
  const [humanError, setHumanError] = useState<string | null>(null);

  async function confirm() {
    if (pending || checking) return;
    setHumanError(null);
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
    await onConfirm(token);
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
