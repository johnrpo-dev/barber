"use client";

import { Check, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Checkbox, Form, Input, Label, Text, TextField } from "react-aria-components";
import { authClient } from "@/lib/auth-client";
import { Btn, cx, field, useToast } from "../../panel/_components/ui";
import { card, FieldMessage, FormError } from "../../panel/_manage/controls";

// Inscripción del TOTP con better-auth: 1) contraseña → secreto y códigos de respaldo (sin activar),
// 2) la persona lo agrega a su app y escribe un código → queda activa, 3) ve los códigos de
// respaldo UNA vez. Hasta el paso 2 la cuenta sigue sin verificación (y el dueño, sin panel).

type AuthError = { status: number; code?: string; message?: string };

function authMessage(error: AuthError, wrong: string): string {
  if (error.status === 429) return "Demasiados intentos. Espera un momento y vuelve a intentar.";
  if (error.code === "INVALID_PASSWORD") return "La contraseña no es correcta.";
  if (error.code === "INVALID_CODE") return wrong;
  if (error.status === 401) return "Tu sesión terminó. Vuelve a ingresar.";
  return wrong;
}

/** La clave para escribirla a mano: grupos de 4 (base32, sin ambigüedad al dictarla). */
function manualKey(totpURI: string): string {
  try {
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    return secret.replace(/(.{4})/g, "$1 ").trim();
  } catch {
    return "";
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Título de cada paso: recibe el foco al llegar, así el lector de pantalla anuncia el cambio. */
function StepHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2 ref={ref} tabIndex={-1} className="font-display text-xl outline-none">
      {children}
    </h2>
  );
}

export function TwoFactorSetup({ enabled, required }: { enabled: boolean; required: boolean }) {
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");

  if (enabled && step !== "codes") return <ManageTwoFactor required={required} />;

  if (step === "password") {
    return (
      <PasswordStep
        title="Paso 1 de 3 · Confirma tu contraseña"
        submitLabel="Continuar"
        onSubmit={async (password) => {
          const { data, error } = await authClient.twoFactor.enable({ password });
          if (error) return authMessage(error as AuthError, "No se pudo iniciar. Intenta de nuevo.");
          if (!data || !("totpURI" in data)) return "No se pudo iniciar. Intenta de nuevo.";
          setEnrollment({ totpURI: data.totpURI, backupCodes: data.backupCodes });
          setStep("scan");
          return null;
        }}
      />
    );
  }
  if (step === "scan" && enrollment) return <ScanStep totpURI={enrollment.totpURI} onVerified={() => setStep("codes")} />;
  if (step === "codes" && enrollment) return <BackupCodes codes={enrollment.backupCodes} first />;
  return null;
}

function PasswordStep({
  title,
  description,
  submitLabel,
  onSubmit,
  tone = "primary",
}: {
  title: string;
  description?: string;
  submitLabel: string;
  /** Devuelve el mensaje de error, o null si salió bien. */
  onSubmit: (password: string) => Promise<string | null>;
  tone?: "primary" | "danger";
}) {
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setFieldError("Escribe tu contraseña.");
      e.currentTarget.querySelector<HTMLElement>('[name="password"]')?.focus();
      return;
    }
    setPending(true);
    const message = await onSubmit(password);
    setPending(false);
    if (message) {
      setPassword("");
      setError(message);
    }
  }

  return (
    <Form onSubmit={submit} className={cx(card, "flex flex-col gap-5 p-5")} validationBehavior="aria">
      <div className="flex flex-col gap-1">
        <StepHeading>{title}</StepHeading>
        {description ? <p className="text-sm text-tinta/80">{description}</p> : null}
      </div>
      <TextField
        name="password"
        type="password"
        value={password}
        onChange={(v) => {
          setPassword(v);
          setFieldError(null);
        }}
        isRequired
        isInvalid={!!fieldError}
        className={field.root}
      >
        <Label className={field.label}>Tu contraseña</Label>
        <Input className={field.input} autoComplete="current-password" />
        <FieldMessage>{fieldError}</FieldMessage>
      </TextField>
      <FormError message={error} />
      <Btn type="submit" variant={tone} isPending={pending} className="self-stretch min-[400px]:self-end">
        {pending ? "Un momento…" : submitLabel}
      </Btn>
    </Form>
  );
}

function ScanStep({ totpURI, onVerified }: { totpURI: string; onVerified: () => void }) {
  const toast = useToast();
  const key = manualKey(totpURI);
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) {
      setFieldError("El código tiene 6 dígitos.");
      e.currentTarget.querySelector<HTMLElement>('[name="code"]')?.focus();
      return;
    }
    setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: value });
    setPending(false);
    if (error) {
      setCode("");
      setFieldError(authMessage(error as AuthError, "Ese código no coincide. Revisa que la hora del celular esté en automático y escribe el código que se ve ahora."));
      return;
    }
    onVerified();
  }

  return (
    <div className={cx(card, "flex flex-col gap-5 p-5")}>
      <div className="flex flex-col gap-1">
        <StepHeading>Paso 2 de 3 · Agrega Villa a tu app</StepHeading>
        <p className="text-sm text-tinta/80">
          Usa una app de verificación como Google Authenticator o Microsoft Authenticator (gratis en la tienda de tu celular).
        </p>
      </div>

      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li className="flex flex-col gap-2">
          <span>Si estás en el celular, ábrela directo:</span>
          <a
            href={totpURI}
            className="inline-flex h-11 items-center justify-center gap-2 self-start rounded-lg border border-tinta/20 bg-papel px-4 font-semibold hover:border-tinta/40"
          >
            <ExternalLink size={16} aria-hidden />
            Abrir en la app de verificación
          </a>
        </li>
        <li className="flex flex-col gap-2">
          <span>
            O en la app elige “Ingresar una clave de configuración”, escribe como cuenta <strong>Villa</strong> y esta clave (tipo
            “basada en tiempo”):
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-hueso px-3 py-2 font-mono text-base tracking-wider break-all" aria-label={`Clave: ${key}`}>
              {key}
            </code>
            <Btn
              variant="secondary"
              size="sm"
              className="h-11"
              onPress={async () => toast((await copy(key.replace(/\s/g, ""))) ? "Clave copiada" : "No se pudo copiar; escríbela a mano.", "success")}
            >
              <Copy size={16} aria-hidden />
              Copiar clave
            </Btn>
          </div>
          <p className="text-xs text-tinta/70">No compartas esta clave: quien la tenga puede generar tus códigos.</p>
        </li>
      </ol>

      <Form onSubmit={submit} className="flex flex-col gap-4 border-t border-tinta/10 pt-4" validationBehavior="aria">
        <TextField
          name="code"
          value={code}
          onChange={(v) => {
            setCode(v);
            setFieldError(null);
          }}
          isRequired
          isInvalid={!!fieldError}
          className={field.root}
        >
          <Label className={field.label}>Escribe el código de 6 dígitos que muestra la app</Label>
          <Input
            className={cx(field.input, "font-mono tracking-widest")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
          />
          <Text slot="description" className={field.description}>
            Así confirmamos que quedó bien antes de activarla.
          </Text>
          <FieldMessage>{fieldError}</FieldMessage>
        </TextField>
        <Btn type="submit" isPending={pending} className="self-stretch min-[400px]:self-end">
          {pending ? "Verificando…" : "Activar verificación"}
        </Btn>
      </Form>
    </div>
  );
}

/** Los códigos de respaldo se muestran una sola vez: la base solo guarda su versión cifrada. */
function BackupCodes({ codes, first }: { codes: string[]; first: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(false);

  return (
    <div className={cx(card, "flex flex-col gap-5 p-5")}>
      <div className="flex flex-col gap-1">
        <StepHeading>{first ? "Paso 3 de 3 · Guarda tus códigos de respaldo" : "Tus códigos de respaldo nuevos"}</StepHeading>
        <p className="text-sm text-tinta/80">
          Si pierdes el celular, cada código te deja entrar una vez. Guárdalos fuera del celular (en papel o en tu gestor de
          contraseñas). <strong>No se vuelven a mostrar.</strong>
          {first ? null : " Los anteriores ya no sirven."}
        </p>
      </div>
      <ul aria-label="Códigos de respaldo" className="grid grid-cols-2 gap-2">
        {codes.map((c) => (
          <li key={c} className="rounded-lg bg-hueso px-3 py-2 text-center font-mono text-base tracking-wider">
            {c}
          </li>
        ))}
      </ul>
      <Btn
        variant="secondary"
        className="self-start"
        onPress={async () => toast((await copy(codes.join("\n"))) ? "Códigos copiados" : "No se pudo copiar; anótalos a mano.")}
      >
        <Copy size={16} aria-hidden />
        Copiar todos
      </Btn>
      <Checkbox isSelected={saved} onChange={setSaved} className="group flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium outline-none">
        <span
          aria-hidden
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-tinta/50 group-data-[selected]:border-botella group-data-[selected]:bg-botella group-data-[focus-visible]:outline-3 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-cuero"
        >
          <Check size={14} className="text-hueso opacity-0 group-data-[selected]:opacity-100" />
        </span>
        Ya los guardé en un lugar seguro
      </Checkbox>
      <Btn
        isDisabled={!saved}
        className="self-stretch min-[400px]:self-end"
        onPress={() => {
          router.replace(first ? "/panel" : "/cuenta");
          router.refresh();
        }}
      >
        <ShieldCheck size={18} aria-hidden />
        {first ? "Listo, ir al panel" : "Listo"}
      </Btn>
    </div>
  );
}

/** Ya activa: códigos de respaldo nuevos y, si el rol no la exige, desactivarla. */
function ManageTwoFactor({ required }: { required: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<"none" | "codes" | "disable">("none");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  if (newCodes) return <BackupCodes codes={newCodes} first={false} />;

  if (action === "codes") {
    return (
      <PasswordStep
        title="Códigos de respaldo nuevos"
        description="Los anteriores dejan de servir."
        submitLabel="Generar códigos nuevos"
        onSubmit={async (password) => {
          const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
          if (error || !data) return authMessage((error ?? { status: 500 }) as AuthError, "No se pudieron generar. Intenta de nuevo.");
          setNewCodes(data.backupCodes);
          return null;
        }}
      />
    );
  }
  if (action === "disable") {
    return (
      <PasswordStep
        title={required ? "Cambiar de celular" : "Desactivar la verificación en dos pasos"}
        description={
          required
            ? "Se borra la inscripción actual y la vuelves a hacer enseguida con el celular nuevo. Mientras tanto no podrás usar el panel."
            : "Tu cuenta quedará protegida solo por la contraseña."
        }
        submitLabel={required ? "Borrar e inscribir de nuevo" : "Desactivar"}
        tone="danger"
        onSubmit={async (password) => {
          const { error } = await authClient.twoFactor.disable({ password });
          if (error) return authMessage(error as AuthError, "No se pudo desactivar. Intenta de nuevo.");
          toast(required ? "Ahora inscribe el celular nuevo" : "Verificación en dos pasos desactivada");
          router.replace(required ? "/cuenta/verificacion" : "/cuenta");
          router.refresh();
          return null;
        }}
      />
    );
  }

  return (
    <div className={cx(card, "flex flex-col gap-4 p-5")}>
      <p className="flex items-center gap-2 font-semibold text-botella">
        <ShieldCheck size={20} aria-hidden />
        Activa
      </p>
      <div className="flex flex-col gap-2 min-[400px]:flex-row">
        <Btn variant="secondary" onPress={() => setAction("codes")}>
          Generar códigos de respaldo nuevos
        </Btn>
        <Btn variant="danger" onPress={() => setAction("disable")}>
          {required ? "Cambiar de celular" : "Desactivar"}
        </Btn>
      </div>
      {required ? (
        <p className="text-xs text-tinta/70">
          Para el dueño es obligatoria. Si perdiste el celular, ingresa con un código de respaldo y usa “Cambiar de celular”.
        </p>
      ) : null}
      <Link href="/cuenta" className="min-h-11 self-start pt-2 text-sm font-semibold text-cuero underline underline-offset-4">
        Volver a Mi cuenta
      </Link>
    </div>
  );
}
