"use client";

import { CalendarX2, ChevronRight, Eye, EyeOff, KeyRound, Plus, Smartphone, UserRound, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, Text, TextField } from "react-aria-components";
import { ROLE_LABELS, type Role } from "@/domain/staff/roles";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { card, Chip, FormError, RadioDot, radioCard, Toggle } from "../_manage/controls";
import { addClosureAction, createStaffAction } from "./actions";
import { TimeOffForm, TimeOffList } from "./time-off";
import type { TimeOffView } from "./time-off-view";

export interface StaffRow {
  id: string;
  displayName: string;
  role: Role;
  active: boolean;
  hasAppAccess: boolean;
  isMe: boolean;
}

/** Orden en que se ofrecen los roles: de lo más común a lo menos. */
export const ROLE_OPTIONS: { role: Role; hint: string }[] = [
  { role: "barber", hint: "Atiende citas y ve sus comisiones" },
  { role: "reception", hint: "Agenda, cobra y cierra caja" },
  { role: "owner", hint: "Acceso total, incluidas las cuentas" },
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function StaffDirectory({
  staff,
  closures,
  today,
  minPasswordLength,
}: {
  staff: StaffRow[];
  closures: TimeOffView[];
  today: string;
  minPasswordLength: number;
}) {
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(false);
  const active = staff.filter((s) => s.active);
  const retired = staff.filter((s) => !s.active);

  return (
    <>
      <PageHeader
        eyebrow="Equipo"
        title="Personal"
        actions={
          <Btn onPress={() => setAdding(true)}>
            <Plus size={18} aria-hidden />
            Agregar persona
          </Btn>
        }
      />

      <section aria-labelledby="equipo-activo" className="flex flex-col gap-3">
        <h2 id="equipo-activo" className="sr-only">
          Personal activo
        </h2>
        {active.length === 0 ? (
          <p className={cx(card, "px-4 py-8 text-center text-sm text-tinta/70")}>Aún no hay personal activo.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {active.map((s) => (
              <StaffCard key={s.id} member={s} />
            ))}
          </ul>
        )}
      </section>

      {retired.length > 0 ? (
        <section aria-labelledby="equipo-retirado" className="flex flex-col gap-3">
          <h2 id="equipo-retirado" className="text-sm font-semibold uppercase tracking-[0.12em] text-tinta/70">
            Retirados
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {retired.map((s) => (
              <StaffCard key={s.id} member={s} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="cierres" className="mt-4 flex flex-col gap-4 border-t border-tinta/10 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="cierres" className="font-display text-2xl leading-tight">
              Cierres de la sede
            </h2>
            <p className="max-w-prose text-sm text-tinta/70">Festivos y días en que nadie atiende. La agenda no ofrece citas esos días.</p>
          </div>
          <Btn variant="secondary" onPress={() => setClosing(true)}>
            <CalendarX2 size={18} aria-hidden />
            Agregar cierre
          </Btn>
        </div>
        <TimeOffList items={closures} showKind={false} emptyText="No hay cierres próximos." />
      </section>

      <Sheet isOpen={adding} onOpenChange={setAdding} title="Agregar persona" description="Quien atiende o administra en esta sede.">
        {adding ? <AddStaffForm minPasswordLength={minPasswordLength} onDone={() => setAdding(false)} /> : null}
      </Sheet>

      <Sheet isOpen={closing} onOpenChange={setClosing} title="Cerrar la sede" description="Días completos, para todo el personal.">
        {closing ? (
          <TimeOffForm
            variant="closure"
            today={today}
            subject="La sede"
            submit={({ reason, range }) =>
              addClosureAction({ reason, ...(range.allDay ? { fromDate: range.fromDate, toDate: range.toDate } : {}) })
            }
            onDone={() => setClosing(false)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function StaffCard({ member }: { member: StaffRow }) {
  return (
    <li>
      <Link
        href={`/panel/personal/${member.id}`}
        className={cx(
          card,
          "group flex min-h-20 items-center gap-4 px-4 py-3 transition-colors hover:border-tinta/25",
          !member.active && "bg-papel/60",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "grid h-12 w-12 shrink-0 place-items-center rounded-full font-display text-lg",
            member.active ? "bg-botella/10 text-botella" : "bg-tinta/5 text-tinta/70",
          )}
        >
          {initials(member.displayName)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className={cx("truncate text-base font-semibold", !member.active && "text-tinta/70")}>
            {member.displayName}
            {member.isMe ? <span className="font-normal text-tinta/70"> (tú)</span> : null}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <Chip tone={member.role === "owner" ? "primary" : "neutral"}>{ROLE_LABELS[member.role]}</Chip>
            {member.hasAppAccess ? (
              <Chip tone="success" icon={<Smartphone size={12} aria-hidden />}>
                Con acceso
              </Chip>
            ) : (
              <Chip tone="muted" icon={<UserRound size={12} aria-hidden />}>
                Solo agenda
              </Chip>
            )}
            {!member.active ? <Chip tone="muted">Retirado</Chip> : null}
          </span>
        </span>
        <ChevronRight size={20} aria-hidden className="shrink-0 text-tinta/40 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

// ─── Agregar persona ─────────────────────────────────────────────────────────

/** Contraseña temporal legible (sin 0/O ni 1/l), generada en el navegador con crypto. */
function generatePassword(length = 16): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function AddStaffForm({ minPasswordLength, onDone }: { minPasswordLength: number; onDone: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("barber");
  const [withAccess, setWithAccess] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Escribe un nombre de al menos 2 caracteres.");
    if (withAccess && !email.trim()) return setError("Escribe el correo con el que va a ingresar.");
    if (withAccess && password.length < minPasswordLength) {
      return setError(`La contraseña temporal debe tener al menos ${minPasswordLength} caracteres.`);
    }
    const payload = withAccess ? { withAccess, name, role, email, password } : { withAccess, name, role };
    startTransition(async () => {
      const res = await createStaffAction(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast(`${name.trim()} quedó en el equipo. Ahora define su horario.`);
      onDone();
      router.push(`/panel/personal/${res.data.staffId}`);
    });
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      <TextField value={name} onChange={setName} isRequired maxLength={80} autoFocus className={field.root}>
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Andrés Gómez" autoComplete="off" />
        <Text slot="description" className={field.description}>
          Así aparece en la agenda y en los recibos.
        </Text>
      </TextField>

      <RadioGroup value={role} onChange={(v) => setRole(v as Role)} className={field.root}>
        <Label className={field.label}>Rol</Label>
        <div className="flex flex-col gap-2">
          {ROLE_OPTIONS.map((o) => (
            <Radio key={o.role} value={o.role} className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="flex flex-col">
                {ROLE_LABELS[o.role]}
                <span className="text-xs font-normal text-tinta/70">{o.hint}</span>
              </span>
            </Radio>
          ))}
        </div>
      </RadioGroup>

      <div className={cx(card, "flex flex-col gap-4 bg-hueso/50 p-4")}>
        <Toggle isSelected={withAccess} onChange={setWithAccess}>
          <span className="flex flex-col">
            <span>Con acceso a la app</span>
            <span className="text-xs font-normal text-tinta/70">
              {withAccess ? "Entrará con correo y contraseña." : "Solo aparece en la agenda; no inicia sesión."}
            </span>
          </span>
        </Toggle>

        {withAccess ? (
          <>
            <TextField value={email} onChange={setEmail} type="email" isRequired className={field.root}>
              <Label className={field.label}>Correo</Label>
              <Input className={field.input} inputMode="email" autoComplete="off" placeholder="andres@correo.com" />
            </TextField>

            <TextField
              value={password}
              onChange={setPassword}
              type={showPassword ? "text" : "password"}
              isRequired
              minLength={minPasswordLength}
              className={field.root}
            >
              <Label className={field.label}>Contraseña temporal</Label>
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tinta/70" />
                  <Input className={cx(field.input, "pl-9 font-mono")} autoComplete="new-password" spellCheck={false} />
                </div>
                <Btn
                  variant="secondary"
                  className="h-12 w-12 shrink-0 px-0"
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  onPress={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                </Btn>
              </div>
              <Text slot="description" className={field.description}>
                Mínimo {minPasswordLength} caracteres. Entrégasela en persona y pídele que la cambie después de su primer ingreso.
              </Text>
            </TextField>
            <Btn
              variant="ghost"
              size="sm"
              className="h-11 self-start"
              onPress={() => {
                setPassword(generatePassword());
                setShowPassword(true);
              }}
            >
              <Wand2 size={16} aria-hidden />
              Generar una segura
            </Btn>
          </>
        ) : null}
      </div>

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onDone} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : "Agregar al equipo"}
        </Btn>
      </div>
    </Form>
  );
}
