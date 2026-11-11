import { ArrowRight, CalendarClock, CheckCircle2, Minus, TrendingDown, TrendingUp, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { dayLong } from "../_components/dates";
import { DeliveryStoppedNotice } from "../_components/delivery-notice";
import { PageHeader } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { loadDashboard } from "./actions";

export const metadata: Metadata = { title: "Inicio · Villa" };

// Tablero del dueño (docs/sprint-5-comisiones-informes.md §7 y §10): 4 indicadores de hoy,
// alertas, lo que se le debe al personal y las próximas citas. Todo llega calculado y formateado
// del servidor; aquí solo se acomoda. Componente de servidor: no hay nada que editar.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Dashboard = OkData<Awaited<ReturnType<typeof loadDashboard>>>;

const card = "rounded-xl border border-tinta/10 bg-papel";

const STATUS_LABEL: Record<Dashboard["upcoming"][number]["status"], string> = {
  pending: "Por confirmar",
  confirmed: "Confirmada",
  arrived: "Llegó",
};

export default async function InicioPage() {
  await requirePermission("reports.financial");
  const result = await loadDashboard();
  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
        <PageHeader title="Inicio" />
        <FormError message={result.error} />
      </main>
    );
  }
  const d = result.data;
  // Respaldos (migración 0031): las fallas van como aviso arriba; lo que está bien, en una línea tenue abajo.
  const backupAlerts = d.backups.filter((b) => b.tone === "alert");
  const backupOk = d.backups.filter((b) => b.tone === "ok");

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <PageHeader eyebrow={dayLong(d.businessDate)} title="Inicio" />
      {d.dayClosed ? (
        <p className="-mt-4 inline-flex items-center gap-2 self-start rounded-full border border-botella/25 bg-botella/10 px-3 py-1 text-xs font-semibold text-botella">
          <CheckCircle2 size={14} aria-hidden /> El día de hoy ya está cerrado
        </p>
      ) : null}

      {/* Indicadores */}
      <section aria-labelledby="indicadores" className="flex flex-col gap-3">
        <h2 id="indicadores" className="sr-only">
          Indicadores de hoy
        </h2>
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {d.kpis.map((k) => (
            <li key={k.key} className={`${card} flex min-w-0 flex-col gap-1.5 p-3.5 sm:p-4`}>
              <p className="text-xs font-semibold leading-tight text-tinta/70">{k.label}</p>
              {/* Sin partir "$ 1.245.000" en dos líneas: a 360 px la cifra cabe a este tamaño. */}
              <p className="monto whitespace-nowrap font-display text-xl leading-tight tracking-tight sm:text-3xl sm:tracking-normal">{k.valueLabel}</p>
              {k.key === "cash" ? (
                <p className="text-xs leading-snug text-tinta/70">
                  {d.cash.open ? (
                    <>
                      Abrió {d.cash.openedBy ?? "el personal"}
                      {d.cash.openedAtLabel ? (
                        <>
                          {" "}
                          a las <span className="monto">{d.cash.openedAtLabel}</span>
                        </>
                      ) : null}
                    </>
                  ) : (
                    "Ábrela en Caja para ver el efectivo"
                  )}
                </p>
              ) : null}
              {k.changeLabel || k.compareLabel ? (
                <p className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-snug text-tinta/70">
                  {k.changeLabel ? <Trend trend={k.trend} label={k.changeLabel} /> : null}
                  {k.compareLabel ? <span className="monto">{k.compareLabel}</span> : null}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* Alertas */}
      <section aria-labelledby="alertas" className="flex flex-col gap-3">
        <h2 id="alertas" className="font-display text-2xl leading-tight">
          Alertas
        </h2>
        {/* Recibos y avisos en cola con el worker sin latir (migración 0030). */}
        {d.deliveryStalled ? <DeliveryStoppedNotice /> : null}
        {backupAlerts.map((b) => (
          <p key={b.kind} role="status" className="flex items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 px-4 py-3 text-sm">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
            <span className="min-w-0 flex-1 font-semibold text-tinta">{b.text}</span>
          </p>
        ))}
        {d.alerts.length === 0 && (d.deliveryStalled || backupAlerts.length > 0) ? null : d.alerts.length === 0 ? (
          <p className={`${card} flex items-center gap-3 px-4 py-3 text-sm text-tinta/80`}>
            <CheckCircle2 size={18} className="shrink-0 text-botella" aria-hidden /> Todo en orden: nada pendiente por revisar.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d.alerts.map((a) => (
              <li key={a.kind}>
                <Link
                  href={a.href}
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-alerta/25 bg-alerta/5 px-4 py-3 text-sm outline-none hover:bg-alerta/10 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero"
                >
                  <TriangleAlert size={18} className="shrink-0 text-alerta" aria-hidden />
                  <span className="min-w-0 flex-1 font-semibold text-tinta">{a.label}</span>
                  {a.count > 1 ? (
                    <span className="monto grid h-7 min-w-7 place-items-center rounded-full bg-alerta px-2 text-xs font-semibold text-hueso">{a.count}</span>
                  ) : null}
                  <ArrowRight size={18} className="shrink-0 text-tinta/60" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {backupOk.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-tinta/70 sm:flex-row sm:flex-wrap sm:gap-x-5">
            {backupOk.map((b) => (
              <li key={b.kind} className="flex items-center gap-1.5">
                <CheckCircle2 size={14} className="shrink-0 text-botella" aria-hidden />
                <span className="monto">{b.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* Por pagar al personal */}
        <section aria-labelledby="por-pagar" className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <h2 id="por-pagar" className="font-display text-2xl leading-tight">
              Por pagar al personal
            </h2>
            <Link href="/panel/comisiones" className="text-sm font-semibold text-cuero underline-offset-4 hover:underline">
              Comisiones
            </Link>
          </div>
          {d.owed.length === 0 ? (
            <p className="text-sm text-tinta/70">No se le debe nada a nadie.</p>
          ) : (
            <ul className={`${card} divide-y divide-tinta/10`}>
              {d.owed.map((o) => (
                <li key={o.staffId}>
                  <Link
                    href={`/panel/comisiones/${o.staffId}`}
                    className="flex min-h-14 items-center gap-3 px-4 py-3 outline-none hover:bg-tinta/5 focus-visible:outline-3 focus-visible:-outline-offset-2 focus-visible:outline-cuero"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{o.name}</span>
                      <span className="monto block text-xs text-tinta/70">
                        Comisión {o.commissionLabel} · Propinas {o.tipsLabel} · Debe {o.receivableLabel}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end">
                      <span className="monto text-lg font-semibold">{o.netLabel}</span>
                      <span className="text-[11px] text-tinta/70">neto estimado</span>
                    </span>
                    <ArrowRight size={16} className="shrink-0 text-tinta/60" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Próximas citas */}
        <section aria-labelledby="proximas" className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <h2 id="proximas" className="font-display text-2xl leading-tight">
              Próximas citas de hoy
            </h2>
            <Link href="/panel/agenda" className="text-sm font-semibold text-cuero underline-offset-4 hover:underline">
              Agenda
            </Link>
          </div>
          {d.upcoming.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-tinta/70">
              <CalendarClock size={16} aria-hidden /> No quedan citas por hoy.
            </p>
          ) : (
            <ul className={`${card} divide-y divide-tinta/10`}>
              {d.upcoming.map((u, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <span className="monto w-12 shrink-0 text-base font-semibold">{u.atLabel}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{u.clientName ?? "Sin nombre"}</span>
                    <span className="block truncate text-xs text-tinta/70">
                      {u.serviceName} · {u.staffName}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full border border-tinta/15 bg-hueso px-2.5 py-0.5 text-[11px] font-semibold text-tinta/80">
                    {STATUS_LABEL[u.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Trend({ trend, label }: { trend: Dashboard["kpis"][number]["trend"]; label: string }) {
  const Icon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const tone = trend === "up" ? "text-botella" : trend === "down" ? "text-alerta" : "text-tinta/70";
  const said = trend === "up" ? "Subió" : trend === "down" ? "Bajó" : "Igual";
  return (
    <span className={`monto inline-flex items-center gap-1 font-semibold ${tone}`}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{said}: </span>
      {label}
    </span>
  );
}
