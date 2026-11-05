import { ChevronLeft, CircleAlert, CircleCheck, LockOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { card, cx } from "../../_components/classes";
import { dayLong } from "../../_components/dates";
import { ExportCsvButton, PeriodBar } from "../../_components/history-controls";
import { PageHeader } from "../../_components/ui";
import { FormError } from "../../_manage/controls";
import { loadCashHistory } from "../actions";

export const metadata: Metadata = { title: "Historial de caja · Villa" };

// Histórico de caja del dueño: cada turno del periodo con su apertura (quién, hora, base contada y
// si cuadró con el libro) y su cierre (esperado, contado y diferencia). Solo cash.review: quien
// cuenta a ciegas no ve el esperado. Las notas del conteo se ven aquí, no en el archivo.

const backLink =
  "inline-flex h-11 items-center gap-1 self-start rounded-lg px-1 text-sm font-semibold text-cuero underline-offset-4 outline-none hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero";

export default async function CashHistoryPage({ searchParams }: { searchParams: Promise<{ desde?: string | string[]; hasta?: string | string[] }> }) {
  await requirePermission("cash.review");
  const sp = await searchParams;
  const view = await loadCashHistory({
    from: typeof sp.desde === "string" ? sp.desde : undefined,
    to: typeof sp.hasta === "string" ? sp.hasta : undefined,
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <Link href="/panel/caja" className={backLink}>
        <ChevronLeft size={18} aria-hidden /> Caja de hoy
      </Link>
      {!view.ok ? (
        <>
          <PageHeader title="Historial de caja" />
          <FormError message={view.error} />
          <Link href="/panel/caja/historial" className="self-start text-sm font-semibold text-cuero underline underline-offset-4">
            Ver este mes
          </Link>
        </>
      ) : (
        <>
          <PageHeader
            title="Historial de caja"
            actions={<ExportCsvButton report="cash_sessions" from={view.data.period.from} to={view.data.period.to} label="Exportar a Excel" />}
          />
          <PeriodBar period={view.data.period} />

          <dl className={cx(card, "grid grid-cols-2 gap-4 p-4")}>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-semibold uppercase tracking-wide text-tinta/70">Diferencias al abrir</dt>
              <dd className="monto text-lg font-semibold">{view.data.openingDifferenceLabel}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-semibold uppercase tracking-wide text-tinta/70">Diferencias al cerrar</dt>
              <dd className="monto text-lg font-semibold">{view.data.closingDifferenceLabel}</dd>
            </div>
          </dl>

          {view.data.sessions.length === 0 ? (
            <p className={cx(card, "p-5 text-tinta/70")}>No se abrió la caja en este periodo.</p>
          ) : (
            <ol className="flex flex-col gap-3" role="list">
              {view.data.sessions.map((s) => (
                <li key={s.id} className={cx(card, "flex flex-col gap-3 p-4")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-semibold first-letter:uppercase">{dayLong(s.openedDate)}</h2>
                    {s.review === "pending" ? (
                      <span className="inline-flex items-center gap-1 text-sm font-semibold text-alerta">
                        <CircleAlert size={16} aria-hidden /> Por revisar
                      </span>
                    ) : s.review === "done" ? (
                      <span className="inline-flex items-center gap-1 text-sm text-tinta/70">
                        <CircleCheck size={16} aria-hidden /> Revisada{s.reviewedBy ? ` por ${s.reviewedBy}` : ""}
                      </span>
                    ) : null}
                  </div>

                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1 rounded-lg bg-tinta/5 p-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-tinta/70">Apertura</dt>
                      <dd className="text-sm">
                        <span className="monto">{s.openedTime}</span> · {s.openedBy}
                      </dd>
                      <dd className="text-sm">
                        Base contada <span className="monto font-semibold">{s.openingCountedLabel}</span>
                      </dd>
                      <dd className={cx("text-sm", s.openingDifferenceLabel ? (s.openingShort ? "font-semibold text-alerta" : "font-semibold") : "text-tinta/70")}>
                        {s.openingDifferenceLabel ? (
                          <>
                            {s.openingShort ? "Faltante" : "Sobrante"} frente al libro <span className="monto">{s.openingDifferenceLabel}</span> · responde {s.openedBy}
                          </>
                        ) : (
                          "Cuadró con el libro"
                        )}
                      </dd>
                      {s.openingNote ? <dd className="text-xs text-tinta/70">Nota: {s.openingNote}</dd> : null}
                    </div>

                    <div className="flex flex-col gap-1 rounded-lg bg-tinta/5 p-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-tinta/70">Cierre</dt>
                      {s.closed ? (
                        <>
                          <dd className="text-sm">
                            {s.closed.date !== s.openedDate ? <span className="first-letter:uppercase">{dayLong(s.closed.date)} · </span> : null}
                            <span className="monto">{s.closed.time}</span> · {s.closed.by}
                          </dd>
                          <dd className="text-sm">
                            Esperado <span className="monto">{s.closed.expectedLabel}</span> · Contado <span className="monto font-semibold">{s.closed.countedLabel}</span>
                          </dd>
                          <dd className={cx("text-sm", s.closed.differenceLabel ? (s.closed.short ? "font-semibold text-alerta" : "font-semibold") : "text-tinta/70")}>
                            {s.closed.differenceLabel ? (
                              <>
                                {s.closed.short ? "Faltante" : "Sobrante"} <span className="monto">{s.closed.differenceLabel}</span> · responde {s.closed.by}
                              </>
                            ) : (
                              "Cuadró"
                            )}
                          </dd>
                          {s.closed.note ? <dd className="text-xs text-tinta/70">Nota: {s.closed.note}</dd> : null}
                        </>
                      ) : (
                        <dd className="inline-flex items-center gap-1 text-sm font-semibold text-botella">
                          <LockOpen size={16} aria-hidden /> Sigue abierta
                        </dd>
                      )}
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </main>
  );
}
