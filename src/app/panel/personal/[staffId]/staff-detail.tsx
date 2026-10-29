"use client";

import { ArrowLeft, CalendarPlus, Smartphone, UserRound } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, Tab, TabList, TabPanel, Tabs, Text, TextField } from "react-aria-components";
import { ROLE_LABELS, type Role } from "@/domain/staff/roles";
import { Btn, cx, field, Sheet, useToast } from "../../_components/ui";
import { card, Chip, FormError, RadioDot, radioCard, Toggle } from "../../_manage/controls";
import { addStaffTimeOffAction, updateStaffProfileAction } from "../actions";
import { initials, ROLE_OPTIONS } from "../staff-directory";
import { TimeOffForm, TimeOffList } from "../time-off";
import type { TimeOffView } from "../time-off-view";
import { type ScheduleBlockInput, ScheduleEditor } from "./schedule-editor";

export interface MemberView {
  id: string;
  displayName: string;
  role: Role;
  active: boolean;
  hasAppAccess: boolean;
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
  schedule,
  timeOff,
  today,
}: {
  member: MemberView;
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

        <TabPanel id="perfil" shouldForceMount className="outline-none data-[inert]:hidden">
          <ProfileForm member={member} />
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
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<Role>(member.role);
  const [active, setActive] = useState(member.active);

  const dirty = displayName !== member.displayName || role !== member.role || active !== member.active;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (displayName.trim().length < 2) return setError("Escribe un nombre de al menos 2 caracteres.");
    startTransition(async () => {
      const res = await updateStaffProfileAction({ staffId: member.id, displayName, role, active });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast("Perfil actualizado");
    });
  }

  return (
    <Form onSubmit={onSubmit} className={cx(card, "flex flex-col gap-5 p-5")} validationBehavior="aria">
      <TextField value={displayName} onChange={setDisplayName} isRequired maxLength={80} className={field.root}>
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} autoComplete="off" />
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
  );
}
