"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, FieldError, Form, Input, Label, TextField } from "react-aria-components";
import { authClient } from "@/lib/auth-client";

const fieldClass = "flex flex-col gap-1.5";
const inputClass =
  "h-12 rounded-lg border border-tinta/25 bg-white px-3 text-base text-tinta outline-none focus-visible:border-cuero data-[invalid]:border-red-700";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(data.get("email")).trim().toLowerCase(),
      password: String(data.get("password")),
    });
    if (error) {
      setPending(false);
      // Mensaje genérico: no revelar si el correo existe.
      setError(
        error.status === 429
          ? "Demasiados intentos. Espera un minuto y vuelve a intentar."
          : "Correo o contraseña incorrectos.",
      );
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

      <Button
        type="submit"
        isPending={pending}
        className="h-12 rounded-lg bg-cuero text-base font-semibold text-hueso transition-colors hover:bg-cuero/90 data-[pending]:opacity-70"
      >
        {pending ? "Ingresando…" : "Ingresar"}
      </Button>
    </Form>
  );
}
