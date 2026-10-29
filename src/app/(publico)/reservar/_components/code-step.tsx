"use client";

import { MessageCircle, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Btn, useToast } from "@/app/panel/_components/ui";
import { OtpField } from "../../_components/otp-field";
import { isError, linkBtn, plural, safeCall } from "../../_lib/ui";
import { resendCode, verifyCode } from "../../actions";

// Paso "Código": un solo input que se envía solo con 6 dígitos, reenvío con cuenta regresiva
// (manda resendAvailableAt del servidor) y "Cambiar número", que vuelve a Datos sin perder nada.

export interface Hold {
  channel: "whatsapp" | "email";
  maskedDestination: string;
  holdExpiresAt: string;
  resendAvailableAt: string;
  sendsLeft: number | null;
}

function useSecondsUntil(iso: string): number {
  const target = Date.parse(iso);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((target - now) / 1000));
  useEffect(() => {
    if (left === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [left === 0, target]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

export function CodeStep({
  hold,
  whatsappUrl,
  onVerified,
  onHoldExpired,
  onHoldChange,
  onChangeNumber,
  onRestart,
}: {
  hold: Hold;
  whatsappUrl: string | null;
  onVerified: (manageUrl: string) => void;
  onHoldExpired: (message: string) => void;
  onHoldChange: (patch: Partial<Hold>) => void;
  onChangeNumber: () => void;
  onRestart: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; network?: boolean } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [codeExpired, setCodeExpired] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resendIn = useSecondsUntil(hold.resendAvailableAt);
  const noMoreSends = hold.sendsLeft === 0;

  async function verify(value: string) {
    if (verifying || blocked) return;
    setVerifying(true);
    setAlert(null);
    const r = await safeCall(() => verifyCode({ code: value }));
    setVerifying(false);
    if (r.ok) {
      onVerified(r.data.manageUrl);
      return;
    }
    if (r.network) {
      setAlert({ message: r.error, network: true });
    } else if (isError(r.error, "wrongCode")) {
      setFieldError(r.error);
      setCode("");
      inputRef.current?.focus();
    } else if (isError(r.error, "codeExpired")) {
      setFieldError(r.error);
      setCodeExpired(true);
    } else if (isError(r.error, "tooManyAttempts")) {
      setBlocked(true);
      setAlert({ message: r.error });
    } else if (isError(r.error, "holdExpired")) {
      onHoldExpired(r.error);
    } else {
      setAlert({ message: r.error });
    }
  }

  async function resend() {
    if (resending) return;
    setResending(true);
    setAlert(null);
    const r = await safeCall(() => resendCode());
    setResending(false);
    if (r.ok) {
      onHoldChange({ resendAvailableAt: r.data.resendAvailableAt, sendsLeft: r.data.sendsLeft });
      setFieldError(null);
      setCodeExpired(false);
      setCode("");
      toast(hold.channel === "whatsapp" ? "Te enviamos un código nuevo por WhatsApp." : "Te enviamos un código nuevo a tu correo.");
      inputRef.current?.focus();
    } else if (isError(r.error, "holdExpired")) {
      onHoldExpired(r.error);
    } else {
      setAlert({ message: r.error });
    }
  }

  const where = hold.channel === "whatsapp" ? `por WhatsApp al ${hold.maskedDestination}` : `a tu correo ${hold.maskedDestination}`;
  const clock = `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-5">
      <OtpField
        inputRef={inputRef}
        value={code}
        onChange={(v) => {
          setCode(v);
          if (fieldError && !codeExpired) setFieldError(null);
        }}
        onComplete={verify}
        description={`Lo enviamos ${where}.`}
        error={fieldError}
        isDisabled={blocked}
      />

      {alert ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4 text-sm font-medium text-alerta">
          <p>{alert.message}</p>
          {alert.network && code.length === 6 ? (
            <Btn variant="secondary" size="sm" className="h-11" onPress={() => verify(code)}>
              Reintentar
            </Btn>
          ) : null}
          {blocked ? (
            <div className="flex flex-wrap gap-2">
              {whatsappUrl ? (
                <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "md")}>
                  <MessageCircle size={18} aria-hidden /> Escríbenos por WhatsApp
                </a>
              ) : null}
              <Btn variant="ghost" onPress={onRestart}>
                <RotateCcw size={18} aria-hidden /> Volver a empezar
              </Btn>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-2">
        {!blocked ? (
          code.length === 6 && !codeExpired ? (
            <Btn size="lg" isPending={verifying} onPress={() => verify(code)}>
              {verifying ? "Verificando…" : "Confirmar cita"}
            </Btn>
          ) : null
        ) : null}

        {!blocked && !noMoreSends ? (
          <Btn variant={codeExpired ? "primary" : "ghost"} isDisabled={resendIn > 0} isPending={resending} onPress={resend} className="-ml-1">
            {codeExpired ? "Enviar código nuevo" : resendIn > 0 ? <span className="monto">Reenviar código en {clock}</span> : "Reenviar código"}
          </Btn>
        ) : null}
        {noMoreSends ? <p className="text-sm text-tinta/70">Ya no quedan reenvíos para esta reserva.</p> : null}
        {hold.sendsLeft !== null && hold.sendsLeft > 0 && hold.sendsLeft < 3 ? (
          <p className="text-xs text-tinta/70">Te quedan {plural(hold.sendsLeft, "reenvío", "reenvíos")}.</p>
        ) : null}

        <Btn variant="ghost" onPress={onChangeNumber} className="-ml-1">
          <Pencil size={16} aria-hidden /> Cambiar número
        </Btn>
      </div>
    </div>
  );
}
