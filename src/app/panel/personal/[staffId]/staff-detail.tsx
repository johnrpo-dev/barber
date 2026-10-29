"use client";

import { ArrowLeft, CalendarPlus, Eye, EyeOff, KeyRound, LogOut, ShieldAlert, ShieldCheck, Smartphone, UserRound, Wand2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, Tab, TabList, TabPanel, Tabs, Text, TextField } from "react-aria-components";
import { ROLE_LABELS, type Role } from "@/domain/staff/roles";
import { useReauth } from "../../_components/reauth";
import { Btn, cx, field, Sheet, useToast } from "../../_components/ui";
import { card, Chip, FieldMessage, FormError, RadioDot, radioCard, Toggle, useFieldErrors } from "../../_manage/controls";
import { addStaffTimeOffAction } from "../../bloqueos/actions";
import { resetStaffPasswordAction, revokeStaffSessionsAction, updateStaffProfileAction } from "../actions";
import { generatePassword, initials, ROLE_OPTIONS } from "../staff-directory";
import { TimeOffForm, TimeOffList } from "../time-off";
import type { TimeOffView } from "../time-off-view";
import { type ScheduleBlockInput, ScheduleEditor } from "./schedule-editor";

export interface MemberView {
  id: string;
  displayName: string;
  role: Role;
  active: boolean;
  hasAppAccess: boolean;
  /** Verificación en dos pasos activa. */
  twoFactorEnabled: boolean;
  /** Tiene una contraseña temporal que aún no cambia. */
  mustChangePassword: boolean;
  isMe: boolean;
}

const tabClass = cx(
  "relative flex h-11 cursor-pointer items-center px-4 text-sm font-semibold text-tinta/70 outline-none transition-colors",
  "hover:text-tinta data-[selected]:text-tinta",
  "after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent data-[selected]:after:bg-cuero",
  "data-[focus-visible]:outline-3 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-cuero",
);

export function StaffDetail({
  member,
  minPasswordLength,
  schedule,
  timeOff,
  today,
}: {
  member: MemberView;
  minPasswordLength: number;
  schedule: ScheduleBlockInput[];
  timeOff: TimeOffView[];
  today: string;
}) {
  const [addingTimeOff, setAddingTimeOff] = useState(false);
  const firstName = member.displayName.split(/\s+/)[0] ?? member.displayName;

  return (
    <>
      <div className="flex flex-col gap-4">
        <Link
          href="/panel/personal"
          className="-ml-2 inline-flex h-11 items-center gap-1.5 self-start rounded-lg px-2 text-sm font-semibold text-tinta/70 hover:bg-tinta/5 hover:text-tinta"
        >
          <ArrowLeft size={16} aria-hidden />
          Personal
        </Link>
        <header className="flex items-center gap-4">
          <span
            aria-hidden
            className={cx(
              "grid h-14 w-14 shrink-0 place-items-center rounded-full font-display text-xl",
              member.active ? "bg-botella/10 text-botella" : "bg-tinta/5 text-tinta/70",
            )}
          >
            {initials(member.displayName)}
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="truncate font-display text-3xl leading-tight">{member.displayName}</h1>
            <div className="flex flex-wrap gap-1.5">
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
              {member.hasAppAccess && member.twoFactorEnabled ? (
                <Chip tone="success" icon={<ShieldCheck size={12} aria-hidden />}>
                  Verificación en dos pasos
                </Chip>
              ) : null}
              {member.hasAppAccess && member.mustChangePassword ? (
                <Chip tone="neutral" icon={<KeyRound size={12} aria-hidden />}>
                  Contraseña temporal
                </Chip>
              ) : null}
            </div>
          </div>
        </header>
      </div>

      <Tabs defaultSelectedKey="horario" className="flex flex-col gap-5">
        <TabList aria-label={`Ficha de ${member.displayName}`} className="-mx-4 flex overflow-x-auto border-b border-tinta/10 px-2 md:mx-0 md:px-0">
          <Tab id="horario" className={tabClass}>
            Horario
          </Tab>
          <Tab id="ausencias" className={tabClass}>
            Ausencias
            {timeOff.length > 0 ? (
              <span className="monto ml-1.5 rounded-full bg-tinta/10 px-1.5 text-xs text-tinta">{timeOff.length}</span>
            ) : null}
          </Tab>
          <Tab id="perfil" className={tabClass}>
            Perfil
          </Tab>
        </TabList>

        {/* Montados siempre: cambiar de pestaña no descarta un horario o un perfil sin guardar. */}
        <TabPanel id="horario" shouldForceMount className="outline-none data-[inert]:hidden">
          <ScheduleEditor staffId={member.id} initial={schedule} />
        </TabPanel>

        <TabPanel id="ausencias" className="flex flex-col gap-4 outline-none">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-prose text-sm text-tinta/70">
              Vacaciones, incapacidades y bloqueos. Mientras duren, {firstName} no aparece disponible en la agenda.
            </p>
            <Btn onPress={() => setAddingTimeOff(true)}>
              <CalendarPlus size={18} aria-hidden />
              Agregar ausencia
            </Btn>
          </div>
          <TimeOffList items={timeOff} staffId={member.id} emptyText={`${firstName} no tiene ausencias próximas.`} />
        </TabPanel>

        <TabPanel id="perfil" shouldForceMount className="flex flex-col gap-5 outline-none data-[inert]:hidden">
          <ProfileForm member={member} />
          {member.hasAppAccess && member.active && !member.isMe ? <AccessPanel member={member} minPasswordLength={minPasswordLength} /> : null}
        </TabPanel>
      </Tabs>

      <Sheet
        isOpen={addingTimeOff}
        onOpenChange={setAddingTimeOff}
        title="Agregar ausencia"
        description={`Tiempo en que ${firstName} no atiende.`}
      >
        {addingTimeOff ? (
          <TimeOffForm
            variant="staff"
            today={today}
            subject={firstName}
            submit={({ kind, reason, range }) => addStaffTimeOffAction({ staffId: member.id, kind, reason, range })}
            onDone={() => setAddingTimeOff(false)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function ProfileForm({ member }: { member: MemberView }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"displayName">();
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<Role>(member.role);
  const [active, setActive] = useState(member.active);
  // Cambiar el rol pide confirmar identidad (lo exige el servidor; aquí se pide y se reintenta).
  const reauth = useReauth();

  const dirty = displayName !== member.displayName || role !== member.role || active !== member.active;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const ok = invalid.check(e.currentTarget, {
      ...(displayName.trim().length < 2 ? { displayName: "Escribe un nombre de al menos 2 caracteres." } : {}),
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await reauth.run(() => updateStaffProfileAction({ staffId: member.id, displayName, role, active }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast("Perfil actualizado");
    });
  }

  return (
    <>
    {/* Fuera del Form: los eventos de React cruzan los portales y un submit del diálogo llegaría aquí. */}
    {reauth.dialog}
    <Form onSubmit={onSubmit} className={cx(card, "flex flex-col gap-5 p-5")} validationBehavior="aria">
      <TextField
        name="displayName"
        value={displayName}
        onChange={(v) => {
          setDisplayName(v);
          invalid.clear("displayName");
        }}
        isRequired
        isInvalid={!!invalid.errors.displayName}
        maxLength={80}
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} autoComplete="off" />
        <FieldMessage>{invalid.errors.displayName}</FieldMessage>
      </TextField>

      <RadioGroup value={role} onChange={(v) => setRole(v as Role)} isDisabled={member.isMe} className={field.root}>
        <Label className={field.label}>Rol</Label>
        <div className="flex flex-col gap-2">
          {ROLE_OPTIONS.map((o) => (
            <Radio key={o.role} value={o.role} className={cx(radioCard, "group data-[disabled]:cursor-default data-[disabled]:opacity-60")}>
              <RadioDot />
              <span className="flex flex-col">
                {ROLE_LABELS[o.role]}
                <span className="text-xs font-normal text-tinta/70">{o.hint}</span>
              </span>
            </Radio>
          ))}
        </div>
        {member.isMe ? (
          <Text slot="description" className={field.description}>
            No puedes cambiar tu propio rol.
          </Text>
        ) : null}
      </RadioGroup>

      <div className="flex flex-col gap-1">
        <Toggle isSelected={active} onChange={setActive} isDisabled={member.isMe}>
          <span className="flex flex-col">
            <span>{active ? "Activo" : "Retirado"}</span>
            <span className="text-xs font-normal text-tinta/70">
              {active
                ? "Aparece en la agenda y, si tiene acceso, puede ingresar."
                : "No aparece en la agenda ni puede ingresar. Su historial se conserva."}
            </span>
          </span>
        </Toggle>
      </div>

      <p className="text-sm text-tinta/70">
        {member.hasAppAccess
          ? "Tiene acceso a la app con su correo. Al retirarlo, pierde el acceso de inmediato."
          : "No tiene acceso a la app: solo aparece en la agenda."}
      </p>

      <FormError message={error} />

      <div className="flex justify-end border-t border-tinta/10 pt-4">
        <Btn type="submit" isPending={pending} isDisabled={!dirty} className="w-full min-[400px]:w-auto">
          {pending ? "Guardando…" : "Guardar perfil"}
        </Btn>
      </div>
    </Form>
    </>
  );
}

// ─── Acceso a la app ─────────────────────────────────────────────────────────

/** Contraseña temporal y cierre de sesiones (celular perdido, alguien que se va, sospecha). */
function AccessPanel({ member, minPasswordLength }: { member: MemberView; minPasswordLength: number }) {
  const toast = useToast();
  const [resetting, setResetting] = useState(false);
  const [closing, startClosing] = useTransition();
  const firstName = member.displayName.split(/\s+/)[0] ?? member.displayName;

  function closeSessions() {
    startClosing(async () => {
      const res = await revokeStaffSessionsAction({ staffId: member.id });
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      const n = res.data.closed;
      toast(n === 0 ? `${firstName} no tenía sesiones abiertas.` : `Se cerraron ${n} ${n === 1 ? "sesión" : "sesiones"} de ${firstName}.`);
    });
  }

  let securityText: string;
  if (member.twoFactorEnabled) securityText = "Ingresa con su contraseña y el código de su app de verificación.";
  else if (member.role === "owner") securityText = "Aún no activa la verificación en dos pasos: se le pedirá en su próximo ingreso.";
  else securityText = "Ingresa solo con contraseña. Puede activar la verificación en dos pasos en “Mi cuenta”.";

  return (
    <section aria-labelledby="acceso-titulo" className={cx(card, "flex flex-col gap-4 p-5")}>
      <div className="flex flex-col gap-1.5">
        <h2 id="acceso-titulo" className="font-display text-xl">
          Acceso a la app
        </h2>
        <p className="flex items-start gap-2 text-sm text-tinta/80">
          {member.twoFactorEnabled ? (
            <ShieldCheck size={16} aria-hidden className="mt-0.5 shrink-0 text-botella" />
          ) : (
            <ShieldAlert size={16} aria-hidden className="mt-0.5 shrink-0" />
          )}
          {securityText}
        </p>
        {member.mustChangePassword ? (
          <p className="text-sm text-tinta/80">Tiene una contraseña temporal: la app le pide cambiarla al ingresar.</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 min-[400px]:flex-row">
        <Btn variant="secondary" onPress={() => setResetting(true)}>
          <KeyRound size={18} aria-hidden />
          Poner contraseña temporal
        </Btn>
        <Btn variant="danger" onPress={closeSessions} isPending={closing}>
          <LogOut size={18} aria-hidden />
          {closing ? "Cerrando…" : "Cerrar sus sesiones"}
        </Btn>
      </div>
      <p className="text-xs text-tinta/70">
        “Cerrar sus sesiones” lo saca de todos sus dispositivos (por ejemplo, si perdió el celular). Puede volver a ingresar con
        su contraseña.
      </p>

      <Sheet
        isOpen={resetting}
        onOpenChange={setResetting}
        title="Contraseña temporal"
        description={`${firstName} tendrá que cambiarla al ingresar. Se cierran todas sus sesiones.`}
      >
        {resetting ? (
          <ResetPasswordForm
            member={member}
            minPasswordLength={minPasswordLength}
            onDone={() => {
              setResetting(false);
              toast(`Listo. Entrégale la contraseña temporal a ${firstName} en persona.`);
            }}
            onCancel={() => setResetting(false)}
          />
        ) : null}
      </Sheet>
    </section>
  );
}

function ResetPasswordForm({
  member,
  minPasswordLength,
  onDone,
  onCancel,
}: {
  member: MemberView;
  minPasswordLength: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"password">();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const reauth = useReauth();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    const ok = invalid.check(e.currentTarget, {
      ...(password.length < minPasswordLength ? { password: `Debe tener al menos ${minPasswordLength} caracteres.` } : {}),
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await reauth.run(() => resetStaffPasswordAction({ staffId: member.id, password }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onDone();
    });
  }

  return (
    <>
      {reauth.dialog}
      <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
        <TextField
          name="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            invalid.clear("password");
          }}
          type={show ? "text" : "password"}
          isRequired
          isInvalid={!!invalid.errors.password}
          autoFocus
          className={field.root}
        >
          <Label className={field.label}>Contraseña temporal</Label>
          <div className="flex gap-2">
            <Input className={cx(field.input, "min-w-0 flex-1 font-mono")} autoComplete="new-password" spellCheck={false} />
            <Btn
              variant="secondary"
              className="h-12 w-12 shrink-0 px-0"
              aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
              onPress={() => setShow((v) => !v)}
            >
              {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
            </Btn>
          </div>
          <Text slot="description" className={field.description}>
            Mínimo {minPasswordLength} caracteres. Entrégasela en persona, nunca por chat.
          </Text>
          <FieldMessage>{invalid.errors.password}</FieldMessage>
        </TextField>
        <Btn
          variant="ghost"
          size="sm"
          className="h-11 self-start"
          onPress={() => {
            setPassword(generatePassword());
            setShow(true);
            invalid.clear("password");
          }}
        >
          <Wand2 size={16} aria-hidden />
          Generar una segura
        </Btn>

        <FormError message={error} />

        <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
          <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
            Cancelar
          </Btn>
          <Btn type="submit" isPending={pending}>
            {pending ? "Guardando…" : "Poner contraseña temporal"}
          </Btn>
        </div>
      </Form>
    </>
  );
}
