import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { card, cx } from "../../_components/classes";
import { dayLong, plural } from "../../_components/dates";
import { ExportCsvButton, PeriodBar } from "../../_components/history-controls";
import { PageHeader } from "../../_components/ui";
import { FormError } from "../../_manage/controls";
import { loadSalesHistory } from "../actions";

export const metadata: Metadata = { title: "Historial de ventas · Villa" };

// Historial de ventas del dueño: una fila por día del periodo con lo cobrado, en efectivo y por
// otros medios, y las propinas; el total del periodo arriba. Todo sumado en SQL. Tocar un día
// abre sus ventas una por una (/panel/ventas?dia=…). Sin datos de clientes.

const backLink =
  "inline-flex h-11 items-center gap-1 self-start rounded-lg px-1 text-sm font-semibold text-cuero underline-offset-4 outline-none hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero";

export default async function SalesHistoryPage({ searchParams }: { searchParams: Promise<{ desde?: string | string[]; hasta?: string | string[] }> }) {
  await requirePermission("reports.financial");
  const sp = await searchParams;
  const view = await loadSalesHistory({
    from: typeof sp.desde === "string" ? sp.desde : undefined,
    to: typeof sp.hasta === "string" ? sp.hasta : undefined,
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <Link href="/panel/ventas" className={backLink}>
        <ChevronLeft size={18} aria-hidden /> Ventas de hoy
      </Link>
      {!view.ok ? (
        <>
          <PageHeader title="Historial de ventas" />
          <FormError message={view.error} />
          <Link href="/panel/ventas/historial" className="self-start text-sm font-semibold text-cuero underline underline-offset-4">
            Ver este mes
          </Link>
        </>
      ) : (
        <>
          <PageHeader
            title="Historial de ventas"
            actions={<ExportCsvButton report="sales" from={view.data.period.from} to={view.data.period.to} label="Exportar a Excel" />}
          />
          <PeriodBar period={view.data.period} />

          <dl className={cx(card, "grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-4")}>
            <Stat label="Cobrado" value={view.data.total.totalLabel} strong />
            <Stat label="Ventas" value={String(view.data.total.paid)} hint={view.data.total.voided > 0 ? plural(view.data.total.voided, "anulada", "anuladas") : undefined} />
            <Stat label="Efectivo" value={view.data.total.cashLabel} />
            <Stat label="Otros medios" value={view.data.total.otherLabel} />
          </dl>
          <p className="-mt-3 text-sm text-tinta/70">
            Incluye <span className="monto">{view.data.total.tipsLabel}</span> de propinas. Las anuladas no suman.
          </p>

          {view.data.days.length === 0 ? (
            <p className={cx(card, "p-5 text-tinta/70")}>No hay ventas en este periodo.</p>
          ) : (
            <ul className={cx(card, "divide-y divide-tinta/10")} role="list">
              {view.data.days.map((d) => (
                <li key={d.date}>
                  <Link
                    href={`/panel/ventas?dia=${d.date}`}
                    className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-tinta/5 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-cuero"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium first-letter:uppercase">{dayLong(d.date)}</span>
                      <span className="truncate text-xs text-tinta/70">
                        <span className="monto">{plural(d.paid, "venta", "ventas")}</span>
                        {d.voided > 0 ? <> · <span className="monto">{plural(d.voided, "anulada", "anuladas")}</span></> : null}
                        {" · "}Efectivo <span className="monto">{d.cashLabel}</span> · Otros <span className="monto">{d.otherLabel}</span>
                      </span>
                    </span>
                    <span className="monto shrink-0 font-semibold">{d.totalLabel}</span>
                    <ChevronRight size={18} className="shrink-0 text-tinta/50" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-tinta/70">{label}</dt>
      <dd className={cx("monto", strong ? "font-display text-2xl" : "text-lg font-semibold")}>{value}</dd>
      {hint ? <dd className="text-xs text-tinta/70">{hint}</dd> : null}
    </div>
  );
}
