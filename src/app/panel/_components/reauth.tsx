"use client";

import { ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { Form, Input, Label, Radio, RadioGroup, Text, TextField } from "react-aria-components";
import type { ActionResult } from "@/lib/action";
import { reauthenticateAction } from "../../cuenta/actions";
import { FieldMessage, FormError, RadioDot, radioCard } from "../_manage/controls";
import { Btn, cx, field, Sheet } from "./ui";

// Confirmar identidad antes de una acción crítica (crear o ascender dueños, cambiar roles,
// contraseñas del personal y, en el sprint 4, las acciones de dinero). El servidor decide: si la
// acción responde code "reauth_required", se pide la contraseña o el código y se reintenta una vez.

const CANCELLED = "No se guardó nada: falta confirmar tu identidad.";

/**
 * `run(() => miAccion(datos))` en lugar de `miAccion(datos)`; `dialog` va en el JSX del componente.
 * `canUseCode`: si tiene la verificación en dos pasos (los dueños siempre).
 */
export function useReauth({ canUseCode = true }: { canUseCode?: boolean } = {}): {
  run: <T>(action: () => Promise<ActionResult<T>>) => Promise<ActionResult<T>>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const finish = useCallback((confirmed: boolean) => {
    setOpen(false);
    resolver.current?.(confirmed);
    resolver.current = null;
  }, []);

  const run = useCallback(async <T,>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
    const first = await action();
    if (first.ok || first.code !== "reauth_required") return first;
    const confirmed = await new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
    if (!confirmed) return { ok: false, error: CANCELLED };
    return action();
  }, []);

  const dialog = (
    <Sheet
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) finish(false);
      }}
      title="Confirma que eres tú"
      description="Esta acción cambia quién puede entrar o qué puede hacer. Confírmala con tu contraseña o con el código de tu app."
    >
      {open ? <ReauthForm canUseCode={canUseCode} onConfirmed={() => finish(true)} onCancel={() => finish(false)} /> : null}
    </Sheet>
  );

  return { run, dialog };
}

function ReauthForm({ canUseCode, onConfirmed, onCancel }: { canUseCode: boolean; onConfirmed: () => void; onCancel: () => void }) {
  const [method, setMethod] = useState<"password" | "totp">(canUseCode ? "totp" : "password");
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // El diálogo vive en un portal: sin esto, el submit seguiría hacia el formulario que lo abrió.
    e.stopPropagation();
    setError(null);
    const code = value.replace(/\s/g, "");
    if (method === "totp" && !/^\d{6}$/.test(code)) {
      setFieldError("El código tiene 6 dígitos.");
      e.currentTarget.querySelector<HTMLElement>('[name="secret"]')?.focus();
      return;
    }
    if (method === "password" && !value) {
      setFieldError("Escribe tu contraseña.");
      e.currentTarget.querySelector<HTMLElement>('[name="secret"]')?.focus();
      return;
    }
    setPending(true);
    const res = await reauthenticateAction(method === "totp" ? { method, code } : { method, password: value });
    setPending(false);
    if (!res.ok) {
      setValue("");
      setError(res.error);
      return;
    }
    onConfirmed();
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      {canUseCode ? (
        <RadioGroup
          value={method}
          onChange={(v) => {
            setMethod(v as "password" | "totp");
            setValue("");
            setFieldError(null);
            setError(null);
          }}
          className={field.root}
        >
          <Label className={field.label}>Confirmar con</Label>
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            <Radio value="totp" className={cx(radioCard, "group")}>
              <RadioDot />
              Código de la app
            </Radio>
            <Radio value="password" className={cx(radioCard, "group")}>
              <RadioDot />
              Contraseña
            </Radio>
          </div>
        </RadioGroup>
      ) : null}

      <TextField
        key={method}
        name="secret"
        value={value}
        onChange={(v) => {
          setValue(v);
          setFieldError(null);
        }}
        type={method === "password" ? "password" : "text"}
        isRequired
        isInvalid={!!fieldError}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>{method === "password" ? "Tu contraseña" : "Código de 6 dígitos"}</Label>
        <Input
          className={cx(field.input, method === "totp" && "font-mono tracking-widest")}
          autoComplete={method === "password" ? "current-password" : "one-time-code"}
          inputMode={method === "password" ? undefined : "numeric"}
          maxLength={method === "password" ? 128 : 7}
          spellCheck={false}
        />
        {method === "totp" ? (
          <Text slot="description" className={field.description}>
            El que muestra ahora tu app de verificación para Villa.
          </Text>
        ) : null}
        <FieldMessage>{fieldError}</FieldMessage>
      </TextField>

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          <ShieldCheck size={18} aria-hidden />
          {pending ? "Confirmando…" : "Confirmar y continuar"}
        </Btn>
      </div>
    </Form>
  );
}
