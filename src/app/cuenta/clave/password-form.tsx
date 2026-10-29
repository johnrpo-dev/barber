"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Text, TextField } from "react-aria-components";
import { Btn, cx, field, useToast } from "../../panel/_components/ui";
import { card, FieldMessage, FormError, useFieldErrors } from "../../panel/_manage/controls";
import { changeOwnPasswordAction } from "../actions";

type Field = "currentPassword" | "newPassword" | "confirm";

export function PasswordForm({ forced, minPasswordLength }: { forced: boolean; minPasswordLength: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<Field>();
  const [values, setValues] = useState<Record<Field, string>>({ currentPassword: "", newPassword: "", confirm: "" });
  const [show, setShow] = useState(false);

  const set = (key: Field) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    invalid.clear(key);
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const { currentPassword, newPassword, confirm } = values;
    const ok = invalid.check(e.currentTarget, {
      ...(!currentPassword ? { currentPassword: forced ? "Escribe la contraseña temporal que te dieron." : "Escribe tu contraseña actual." } : {}),
      ...(newPassword.length < minPasswordLength ? { newPassword: `Debe tener al menos ${minPasswordLength} caracteres.` } : {}),
      ...(newPassword.length >= minPasswordLength && newPassword === currentPassword
        ? { newPassword: "Debe ser distinta de la actual." }
        : {}),
      ...(confirm !== newPassword ? { confirm: "No coincide con la contraseña nueva." } : {}),
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await changeOwnPasswordAction({ currentPassword, newPassword });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast("Contraseña actualizada");
      // El panel decide si falta algo más (a un dueño le pide la verificación en dos pasos).
      router.replace(forced ? "/panel" : "/cuenta");
      router.refresh();
    });
  }

  const input = (name: Field, label: string, autoComplete: string, description?: string) => (
    <TextField
      name={name}
      value={values[name]}
      onChange={set(name)}
      type={show ? "text" : "password"}
      isRequired
      isInvalid={!!invalid.errors[name]}
      maxLength={128}
      className={field.root}
    >
      <Label className={field.label}>{label}</Label>
      <Input className={field.input} autoComplete={autoComplete} spellCheck={false} />
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
      <FieldMessage>{invalid.errors[name]}</FieldMessage>
    </TextField>
  );

  return (
    <Form onSubmit={onSubmit} className={cx(card, "flex flex-col gap-5 p-5")} validationBehavior="aria">
      {input("currentPassword", forced ? "Contraseña temporal" : "Contraseña actual", "current-password")}
      {input(
        "newPassword",
        "Contraseña nueva",
        "new-password",
        `Mínimo ${minPasswordLength} caracteres. Una frase larga es más fácil de recordar y más segura.`,
      )}
      {input("confirm", "Repite la contraseña nueva", "new-password")}

      <Btn variant="ghost" size="sm" className="h-11 self-start" onPress={() => setShow((v) => !v)}>
        {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        {show ? "Ocultar contraseñas" : "Mostrar contraseñas"}
      </Btn>

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        {forced ? null : (
          <Link
            href="/cuenta"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-tinta/20 bg-papel px-4 text-sm font-semibold text-tinta hover:border-tinta/40"
          >
            Cancelar
          </Link>
        )}
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : "Guardar contraseña"}
        </Btn>
      </div>
    </Form>
  );
}
