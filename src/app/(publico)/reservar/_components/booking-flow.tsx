"use client";

import { Clock, MessageCircle, Scissors, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "@/app/panel/_components/ui";
import type { PortalView } from "../../data";
import { loadDaySummary, loadPublicSlots, startBooking } from "../../actions";
import { HoldTimer } from "../../_components/hold-timer";
import { SlotChooser } from "../../_components/slot-chooser";
import { StepHeading } from "../../_components/step-heading";
import { Ticket } from "../../_components/ticket";
import { capitalize, cx, isError, linkBtn, longDate, phoneDigits, safeCall, shortWeekdayDay, type SlotView } from "../../_lib/ui";
import { ServiceStep, StaffStep } from "./choice-steps";
import { CodeStep, type Hold } from "./code-step";
import { type Details, DetailsStep } from "./details-step";

// Flujo de reserva pública en una sola página (contrato §10):
// Servicio → Barbero → Hora → Datos → Código → /cita/[token]?nueva=1.
// Cada paso: foco al título, document.title y una entrada en el historial (el "atrás" de Android
// vuelve al paso anterior). Lo escrito vive en memoria y en sessionStorage: volver no pierde nada.

type StepId = "service" | "staff" | "time" | "details" | "code";

const STEPS: { id: StepId; label: string; title: string }[] = [
  { id: "service", label: "Servicio", title: "Elige el servicio" },
  { id: "staff", label: "Barbero", title: "Elige tu barbero" },
  { id: "time", label: "Hora", title: "Elige la hora" },
  { id: "details", label: "Datos", title: "Tus datos" },
  { id: "code", label: "Código", title: "Escribe el código" },
];
const ORDER = STEPS.map((s) => s.id);

const STORAGE_KEY = "villa.reservar.v1";
const HOLD_EXPIRED = "Se acabó el tiempo y liberamos el horario. Elige otro; tus datos siguen aquí.";

export interface BookingPortal {
  services: PortalView["services"];
  staff: PortalView["staff"];
  today: string;
  whatsappUrl: string | null;
  turnstileSiteKey: string | null;
  holdMin: number;
}

interface FlowState {
  v: 1;
  step: StepId;
  serviceId: string | null;
  staffId: string;
  date: string | null;
  minute: number | null;
  slotLabel: string | null;
  details: Details;
  hold: Hold | null;
  /** Clave de idempotencia de startBooking: se conserva en reintentos por red, se renueva tras una respuesta. */
  formId: string;
  /** El barbero llegó en la URL: su paso se salta (sigue disponible con "Cambiar"). */
  skipStaff: boolean;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function initialState(serviceId: string | null, staffId: string | null): FlowState {
  return {
    v: 1,
    step: serviceId ? (staffId ? "time" : "staff") : "service",
    serviceId,
    staffId: staffId ?? "any",
    date: null,
    minute: null,
    slotLabel: null,
    details: { name: "", phone: "", email: "", consents: { dataProcessing: false, reminders: false, marketing: false } },
    hold: null,
    formId: newId(),
    skipStaff: !!staffId,
  };
}

/** El paso más avanzado al que se puede llegar con lo que hay (p. ej. sin hora no hay "Datos"). */
function reachable(s: FlowState, want: StepId): StepId {
  const ok: Record<StepId, boolean> = {
    service: true,
    staff: !!s.serviceId,
    time: !!s.serviceId,
    details: !!s.serviceId && !!s.date && s.minute !== null,
    code: !!s.hold,
  };
  let i = ORDER.indexOf(want);
  while (i > 0 && !ok[ORDER[i]!]) i--;
  return ORDER[Math.max(0, i)]!;
}

function readSaved(): FlowState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as FlowState) : null;
    return saved?.v === 1 && ORDER.includes(saved.step) ? saved : null;
  } catch {
    return null;
  }
}

function writeSaved(s: FlowState | null) {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Modo privado o almacenamiento lleno: el flujo sigue en memoria.
  }
}

function pushStep(step: StepId, replace = false) {
  try {
    if (replace) window.history.replaceState({ ...window.history.state, villaStep: step }, "");
    else window.history.pushState({ villaStep: step }, "");
  } catch {
    // Sin historial (iframes restringidos): el flujo funciona igual, sin "atrás" por pasos.
  }
}

export function BookingFlow({
  portal,
  initialServiceId,
  initialStaffId,
}: {
  portal: BookingPortal;
  initialServiceId: string | null;
  initialStaffId: string | null;
}) {
  const router = useRouter();
  const [s, setS] = useState<FlowState>(() => initialState(initialServiceId, initialStaffId));
  const [restored, setRestored] = useState(false);
  const [timeAlert, setTimeAlert] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; seq: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusOnStep = useRef(false);

  const patch = useCallback((p: Partial<FlowState>) => setS((prev) => ({ ...prev, ...p })), []);

  const goTo = useCallback((step: StepId) => {
    focusOnStep.current = true;
    setS((prev) => ({ ...prev, step }));
    pushStep(step);
  }, []);

  // ─── Restaurar lo guardado (si es compatible con la URL y con la carta vigente) ──
  useEffect(() => {
    const saved = readSaved();
    const compatible =
      saved &&
      (!initialServiceId || saved.serviceId === initialServiceId) &&
      (!initialStaffId || saved.staffId === initialStaffId) &&
      (saved.serviceId === null || portal.services.some((x) => x.id === saved.serviceId)) &&
      (saved.staffId === "any" || portal.staff.some((x) => x.id === saved.staffId));
    let start = s;
    if (saved && compatible) {
      start = saved;
      if (start.hold && Date.parse(start.hold.holdExpiresAt) <= Date.now()) {
        start = { ...start, hold: null, minute: null, slotLabel: null, step: "time", formId: newId() };
        setTimeAlert(HOLD_EXPIRED);
      }
      start = { ...start, step: reachable(start, start.step) };
      setS(start);
    }
    pushStep(start.step, true);
    setRestored(true);
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (restored) writeSaved(s);
  }, [s, restored]);

  // ─── Atrás / adelante del navegador ──────────────────────────────────────
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const want = (e.state as { villaStep?: StepId } | null)?.villaStep;
      if (!want || !ORDER.includes(want)) return;
      focusOnStep.current = true;
      setS((prev) => ({ ...prev, step: reachable(prev, want) }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ─── Título del documento y foco en cada cambio de paso ──────────────────
  const meta = STEPS.find((x) => x.id === s.step)!;
  useEffect(() => {
    document.title = `${meta.title} · Reservar · Villa`;
    if (focusOnStep.current) {
      focusOnStep.current = false;
      headingRef.current?.focus();
    }
  }, [s.step, meta.title]);

  // ─── Datos derivados ─────────────────────────────────────────────────────
  const service = portal.services.find((x) => x.id === s.serviceId) ?? null;
  const barber = s.staffId === "any" ? null : (portal.staff.find((x) => x.id === s.staffId) ?? null);
  const staffName = barber?.name ?? "Cualquiera";
  const idx = ORDER.indexOf(s.step);
  const whenText = s.date && s.slotLabel ? `${capitalize(shortWeekdayDay(s.date))} · ${s.slotLabel}` : null;

  // ─── Acciones ────────────────────────────────────────────────────────────
  const holdExpired = useCallback(
    (message: string = HOLD_EXPIRED) => {
      patch({ hold: null, minute: null, slotLabel: null, formId: newId() });
      setTimeAlert(message);
      setReloadToken((n) => n + 1);
      goTo("time");
    },
    [patch, goTo],
  );

  function chooseStaff(id: string) {
    patch({ staffId: id, minute: null, slotLabel: null, hold: null, skipStaff: false });
  }

  function chooseSlot(slot: SlotView | null) {
    if (slot && slot.minute === s.minute) return;
    patch({ minute: slot?.minute ?? null, slotLabel: slot?.label ?? null, ...(slot ? { hold: null } : {}) });
    if (slot) setTimeAlert(null);
  }

  async function submitDetails(turnstileToken: string) {
    if (!s.serviceId || !s.date || s.minute === null) return;
    setPending(true);
    setServerError(null);
    const { details } = s;
    const r = await safeCall(() =>
      startBooking({
        serviceId: s.serviceId!,
        staffId: s.staffId,
        date: s.date!,
        minute: s.minute!,
        name: details.name.trim(),
        phone: phoneDigits(details.phone),
        email: details.email.trim() || undefined,
        consents: details.consents,
        turnstileToken,
        formId: s.formId,
      }),
    );
    setPending(false);
    if (r.ok) {
      patch({ hold: { ...r.data, sendsLeft: null }, formId: newId() });
      goTo("code");
      return;
    }
    // Una respuesta del servidor cierra este intento; un fallo de red se reintenta con la misma clave.
    if (!r.network) patch({ formId: newId() });
    if (isError(r.error, "slotTaken") || isError(r.error, "tooSoon") || isError(r.error, "holdExpired")) {
      patch({ minute: null, slotLabel: null, hold: null });
      setTimeAlert(r.error);
      setReloadToken((n) => n + 1);
      goTo("time");
      return;
    }
    setServerError({ message: r.error, seq: Date.now() });
  }

  function verified(manageUrl: string) {
    writeSaved(null);
    router.push(`${manageUrl}${manageUrl.includes("?") ? "&" : "?"}nueva=1`);
  }

  // ─── Barra inferior (pasos de elección) ──────────────────────────────────
  const bar =
    s.step === "service"
      ? { text: service ? `${service.name} · ${service.priceLabel}` : "Elige un servicio", can: !!service, next: () => goTo(s.skipStaff ? "time" : "staff") }
      : s.step === "staff"
        ? { text: staffName, can: true, next: () => goTo("time") }
        : s.step === "time"
          ? { text: whenText ?? "Elige un horario", can: s.minute !== null, next: () => goTo("details") }
          : null;

  const chips = [
    idx > 0 && service ? { step: "service" as const, icon: Scissors, text: service.name } : null,
    idx > 1 ? { step: "staff" as const, icon: UserRound, text: staffName } : null,
    idx > 2 && whenText ? { step: "time" as const, icon: Clock, text: whenText } : null,
  ].filter((c) => c !== null);

  const hint =
    s.step === "staff"
      ? "Si te da igual, elige Cualquiera y te asignamos el primero que esté libre."
      : s.step === "details"
        ? `Te enviamos un código para confirmar. Mientras tanto te guardamos el horario ${portal.holdMin} minutos.`
        : undefined;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-32 pt-6 md:pb-12 lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-12">
      <div className="flex min-w-0 flex-col gap-5">
        <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">Reserva tu turno</h1>

        <ol aria-label="Pasos" className="grid grid-cols-5 gap-1.5">
          {STEPS.map((st, i) => (
            <li key={st.id} aria-current={i === idx ? "step" : undefined} className="flex flex-col gap-1">
              <span aria-hidden className={cx("h-1 rounded-full transition-colors", i <= idx ? "bg-cuero" : "bg-tinta/10")} />
              <span className={cx("text-xs font-semibold", i === idx ? "text-tinta" : "text-tinta/70")}>
                {st.label}
                {i < idx ? <span className="sr-only">, listo</span> : null}
              </span>
            </li>
          ))}
        </ol>

        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c.step}
                type="button"
                onClick={() => goTo(c.step)}
                aria-label={`Cambiar: ${c.text}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-tinta/15 bg-papel px-3.5 text-sm font-semibold transition-colors hover:border-tinta/40"
              >
                <c.icon size={14} aria-hidden /> {c.text}
              </button>
            ))}
          </div>
        ) : null}

        {s.hold && (s.step === "details" || s.step === "code") ? (
          <HoldTimer key={s.hold.holdExpiresAt} expiresAt={s.hold.holdExpiresAt} onExpire={holdExpired} />
        ) : null}

        <section key={s.step} aria-labelledby="paso-h" className="flex animate-fade-in flex-col gap-5">
          <StepHeading ref={headingRef} hint={hint}>
            <span id="paso-h">{meta.title}</span>
          </StepHeading>

          {s.step === "service" ? (
            <ServiceStep services={portal.services} value={s.serviceId} onChange={(id) => patch({ serviceId: id, minute: null, slotLabel: null, hold: null })} />
          ) : null}

          {s.step === "staff" ? <StaffStep staff={portal.staff} value={s.staffId} onChange={chooseStaff} /> : null}

          {s.step === "time" && s.serviceId ? (
            <>
              {timeAlert ? (
                <p role="alert" className="rounded-xl border border-alerta/30 bg-alerta/5 p-4 text-sm font-medium text-alerta">
                  {timeAlert}
                </p>
              ) : null}
              <SlotChooser
                daysKey={`${s.serviceId}|${s.staffId}`}
                loadDays={() => loadDaySummary({ serviceId: s.serviceId!, staffId: s.staffId })}
                loadSlots={(date) => loadPublicSlots({ serviceId: s.serviceId!, staffId: s.staffId, date })}
                today={portal.today}
                date={s.date}
                onDateChange={(date) => patch({ date, minute: null, slotLabel: null })}
                value={s.minute}
                onChange={chooseSlot}
                reloadToken={reloadToken}
                noDaysMessage={
                  barber
                    ? `${barber.name.split(/\s+/)[0]} no tiene turnos en las próximas dos semanas.`
                    : "No quedan turnos en las próximas dos semanas."
                }
                emptyActions={
                  <>
                    {barber ? (
                      <Btn variant="secondary" onPress={() => chooseStaff("any")}>
                        Probar con Cualquiera
                      </Btn>
                    ) : null}
                    {portal.whatsappUrl ? (
                      <a href={portal.whatsappUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "md")}>
                        <MessageCircle size={18} aria-hidden /> Escríbenos
                      </a>
                    ) : null}
                  </>
                }
              />
            </>
          ) : null}

          {s.step === "details" ? (
            <DetailsStep
              value={s.details}
              onChange={(p) => setS((prev) => ({ ...prev, details: { ...prev.details, ...p } }))}
              onSubmit={submitDetails}
              pending={pending}
              serverError={serverError}
              turnstileSiteKey={portal.turnstileSiteKey}
            />
          ) : null}

          {s.step === "code" && s.hold ? (
            <CodeStep
              hold={s.hold}
              whatsappUrl={portal.whatsappUrl}
              onVerified={verified}
              onHoldExpired={holdExpired}
              onHoldChange={(p) => setS((prev) => (prev.hold ? { ...prev, hold: { ...prev.hold, ...p } } : prev))}
              onChangeNumber={() => goTo("details")}
              onRestart={() => {
                patch({ hold: null, minute: null, slotLabel: null, formId: newId() });
                setReloadToken((n) => n + 1);
                goTo("time");
              }}
            />
          ) : null}
        </section>
      </div>

      {/* Ticket "borrador" que se va llenando (pantallas anchas). Repite lo que dicen los pasos: oculto al lector. */}
      <aside aria-hidden className="hidden lg:sticky lg:top-6 lg:block">
        <Ticket
          headingId="ticket-borrador-h"
          data={{
            code: null,
            timeLabel: s.slotLabel,
            dateLabel: s.date && s.slotLabel ? longDate(s.date) : null,
            serviceName: service?.name ?? null,
            staffName: idx > 1 || s.skipStaff ? staffName : null,
            durationMin: service?.durationMin ?? null,
            priceLabel: service?.priceLabel ?? null,
            address: null,
            stamp: { label: "Borrador", tone: "draft" },
          }}
        />
      </aside>

      {bar ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-tinta/10 bg-papel/95 px-4 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))] backdrop-blur md:static md:col-start-1 md:mt-6 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 md:mx-0 md:max-w-none">
            <p className="min-w-0 truncate text-sm font-medium" aria-hidden>
              {bar.text}
            </p>
            <Btn size="lg" className="shrink-0" isDisabled={!bar.can} onPress={bar.next}>
              Continuar
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}

