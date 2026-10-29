"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, FieldError, Form, Input, Label, Text, TextField } from "react-aria-components";
import { authClient } from "@/lib/auth-client";

const fieldClass = "flex flex-col gap-1.5";
const inputClass =
  "h-12 rounded-lg border border-tinta/25 bg-white px-3 text-base text-tinta outline-none focus-visible:border-cuero data-[invalid]:border-red-700";
const primaryButton =
  "h-12 rounded-lg bg-cuero text-base font-semibold text-hueso transition-colors hover:bg-cuero/90 data-[pending]:opacity-70";
const linkButton = "min-h-11 self-start text-sm font-semibold text-cuero underline underline-offset-4";

type AuthError = { status: number; code?: string; message?: string };

/** Mensajes genéricos: nunca dicen si el correo existe ni cuál de los datos falló. */
function signInMessage(error: AuthError): string {
  if (error.status === 429) {
    return error.code === "ACCOUNT_LOCKED" && error.message ? error.message : "Demasiados intentos. Espera un minuto y vuelve a intentar.";
  }
  return "Correo o contraseña incorrectos.";
}

function codeMessage(error: AuthError, backup: boolean): string {
  if (error.status === 429) return "Demasiados intentos. Espera unos minutos y vuelve a intentar.";
  if (error.status === 401 && /two.?factor|cookie|session/i.test(error.code ?? "")) {
    return "La verificación venció. Vuelve a escribir tu correo y contraseña.";
  }
  return backup ? "Ese código de respaldo no es válido o ya se usó." : "El código no es correcto. Revisa que sea el que se ve ahora en tu app.";
}

export function LoginForm() {
  const [step, setStep] = useState<"password" | "code">("password");
  return step === "password" ? <PasswordStep onNeedsCode={() => setStep("code")} /> : <CodeStep onRestart={() => setStep("password")} />;
}

function PasswordStep({ onNeedsCode }: { onNeedsCode: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data: result, error } = await authClient.signIn.email({
      email: String(data.get("email")).trim().toLowerCase(),
      password: String(data.get("password")),
    });
    if (error) {
      setPending(false);
      setError(signInMessage(error as AuthError));
      return;
    }
    if (result && "twoFactorRedirect" in result && result.twoFactorRedirect) {
      onNeedsCode();
      return;
    }
    router.replace("/panel");
    router.refresh();
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5">
      <TextField name="email" type="email" autoComplete="username" isRequired className={fieldClass}>
        <Label className="text-sm font-semibold">Correo</Label>
        <Input className={inputClass} inputMode="email" />
        <FieldError className="text-sm text-red-800">Escribe tu correo.</FieldError>
      </TextField>

      <TextField name="password" type="password" autoComplete="current-password" isRequired className={fieldClass}>
        <Label className="text-sm font-semibold">Contraseña</Label>
        <Input className={inputClass} />
        <FieldError className="text-sm text-red-800">Escribe tu contraseña.</FieldError>
      </TextField>

      <p role="alert" aria-live="polite" className="min-h-5 text-sm font-medium text-red-800">
        {error}
      </p>

      <Button type="submit" isPending={pending} className={primaryButton}>
        {pending ? "Ingresando…" : "Ingresar"}
      </Button>
    </Form>
  );
}

/** Segundo paso: el código de 6 dígitos de la app de verificación o un código de respaldo. */
function CodeStep({ onRestart }: { onRestart: () => void }) {
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Al llegar a este paso, el foco va al título (el lector de pantalla anuncia qué se pide).
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = backup ? code.trim() : code.replace(/\s/g, "");
    if (!backup && !/^\d{6}$/.test(value)) {
      setError("El código tiene 6 dígitos.");
      return;
    }
    if (backup && value.length < 6) {
      setError("Escribe uno de tus códigos de respaldo.");
      return;
    }
    setPending(true);
    setError(null);
    const { error } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: value })
      : await authClient.twoFactor.verifyTotp({ code: value });
    if (error) {
      setPending(false);
      setCode("");
      setError(codeMessage(error as AuthError, backup));
      return;
    }
    router.replace("/panel");
    router.refresh();
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      <div className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="font-display text-2xl outline-none">
          Verificación en dos pasos
        </h2>
        <p className="text-sm text-tinta/80">
          {backup
            ? "Escribe uno de los códigos de respaldo que guardaste. Cada uno sirve una sola vez."
            : "Abre tu app de verificación (Google Authenticator, Microsoft Authenticator u otra) y escribe el código de 6 dígitos de Villa."}
        </p>
      </div>

      <TextField
        key={backup ? "backup" : "totp"}
        name="code"
        value={code}
        onChange={(v) => {
          setCode(v);
          setError(null);
        }}
        isRequired
        isInvalid={!!error}
        autoFocus
        className={fieldClass}
      >
        <Label className="text-sm font-semibold">{backup ? "Código de respaldo" : "Código de 6 dígitos"}</Label>
        <Input
          className={`${inputClass} font-mono tracking-widest`}
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={backup ? 32 : 7}
          spellCheck={false}
          autoCapitalize="off"
        />
        <Text slot="description" className="text-xs text-tinta/80">
          {backup ? "Tal como lo guardaste, con o sin guion." : "El código cambia cada 30 segundos."}
        </Text>
      </TextField>

      <p role="alert" aria-live="polite" className="min-h-5 text-sm font-medium text-red-800">
        {error}
      </p>

      <Button type="submit" isPending={pending} className={primaryButton}>
        {pending ? "Verificando…" : "Verificar"}
      </Button>

      <div className="flex flex-col gap-1">
        <Button
          className={linkButton}
          onPress={() => {
            setBackup((b) => !b);
            setCode("");
            setError(null);
          }}
        >
          {backup ? "Usar el código de la app" : "No tengo el celular: usar un código de respaldo"}
        </Button>
        <Button className={linkButton} onPress={onRestart}>
          Volver a ingresar con otro correo
        </Button>
      </div>
    </Form>
  );
}
