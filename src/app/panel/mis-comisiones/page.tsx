import { ChevronRight, HandCoins, ReceiptText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { dayLong, dayShort, plural } from "../_components/dates";
import { PageHeader } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { loadMyCommissions } from "./actions";

export const metadata: Metadata = { title: "Mis comisiones · Villa" };

// Lo del barbero, solo lo suyo (docs/sprint-5-comisiones-informes.md §10): lo pendiente hasta hoy,
// anulaciones por descontar, propinas, lo que debe y sus liquidaciones y anticipos con su
// comprobante. La persona sale de la sesión en el servidor, nunca de la URL.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Mine = OkData<Awaited<ReturnType<typeof loadMyCommissions>>>;

const card = "rounded-xl border border-tinta/10 bg-papel";

export default async function MisComisionesPage() {
  await requirePermission("commissions.view.own");
  const result = await loadMyCommissions();
  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
        <PageHeader title="Mis comisiones" />
        <FormError message={result.error} />
      </main>
    );
  }
  const m = result.data;
  const days = groupByDay(m.pending.lines);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <PageHeader eyebrow={dayLong(m.businessDate)} title="Mis comisiones" />

      {/* Resumen */}
      <section aria-labelledby="resumen" className={`${card} flex flex-col gap-4 p-4 md:p-6`}>
        <h2 id="resumen" className="sr-only">
          Resumen
        </h2>
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">Te pagarían hoy (estimado)</p>
          <p className="monto font-display text-4xl leading-tight">{m.estimatedPayoutLabel}</p>
          <p className="text-xs text-tinta/70">Con propinas y descontando anticipos. El valor exacto sale en tu liquidación.</p>
        </div>
        <dl className="grid grid-cols-1 gap-3 border-t border-tinta/10 pt-4 text-sm min-[400px]:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-xs text-tinta/70">Comisiones pendientes</dt>
            <dd className="monto text-lg font-semibold">{m.pending.totalLabel}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-tinta/70">Propinas por cobrar</dt>
            <dd className="monto text-lg font-semibold">{m.tipsOwedLabel}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-tinta/70">Debes (anticipos)</dt>
            <dd className="monto text-lg font-semibold">{m.receivableLabel}</dd>
          </div>
        </dl>
      </section>

      {/* Pendiente */}
      <section aria-labelledby="pendiente" className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <h2 id="pendiente" className="font-display text-2xl leading-tight">
            Pendiente de liquidar
          </h2>
          <span className="text-sm text-tinta/70">{plural(m.pending.lines.length, "servicio", "servicios")}</span>
        </div>
        {m.pending.lines.length === 0 ? (
          <p className="text-sm text-tinta/70">No tienes comisiones pendientes.</p>
        ) : (
          <div className={`${card} flex flex-col overflow-hidden`}>
            {days.map((d) => (
              <div key={d.date} className="flex flex-col">
                <h3 className="bg-tinta/[0.04] px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-tinta/70">{dayShort(d.date)}</h3>
                <ul className="divide-y divide-tinta/10">
                  {d.lines.map((l, i) => (
                    <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{l.description}</span>
                        <span className="monto block text-xs text-tinta/70">
                          Neto {l.netLabel} · {l.rateLabel}
                        </span>
                      </span>
                      <span className="monto shrink-0 whitespace-nowrap font-semibold">{l.commissionLabel}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {m.clawbacks.length > 0 ? (
        <section aria-labelledby="anulaciones" className="flex flex-col gap-3">
          <h2 id="anulaciones" className="font-display text-2xl leading-tight">
            Por descontar
          </h2>
          <p className="-mt-1 text-sm text-tinta/70">Ventas que se anularon después de pagarte la comisión. Se descuentan en tu próxima liquidación.</p>
          <ul className={`${card} divide-y divide-tinta/10`}>
            {m.clawbacks.map((c, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.description}</span>
                  <span className="monto block text-xs text-tinta/70">{dayShort(c.businessDate)}</span>
                </span>
                <span className="monto shrink-0 whitespace-nowrap font-semibold text-alerta">−{c.amountLabel}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="mis-liquidaciones" className="flex flex-col gap-3">
          <h2 id="mis-liquidaciones" className="font-display text-2xl leading-tight">
            Liquidaciones
          </h2>
          {m.settlements.length === 0 ? (
            <p className="text-sm text-tinta/70">Todavía no tienes liquidaciones.</p>
          ) : (
            <ul className={`${card} divide-y divide-tinta/10`}>
              {m.settlements.map((s) => (
                <li key={s.publicId}>
                  <ReceiptLink
                    href={`/panel/comprobantes/${s.publicId}`}
                    icon="receipt"
                    title={s.numberLabel}
                    detail={`Corte ${dayShort(s.cutoffDate)} · pagada ${dayShort(s.businessDate)}`}
                    amount={s.payoutLabel}
                    reversed={s.status === "reversed"}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="mis-anticipos" className="flex flex-col gap-3">
          <h2 id="mis-anticipos" className="font-display text-2xl leading-tight">
            Anticipos
          </h2>
          {m.advances.length === 0 ? (
            <p className="text-sm text-tinta/70">No tienes anticipos.</p>
          ) : (
            <ul className={`${card} divide-y divide-tinta/10`}>
              {m.advances.map((a) => (
                <li key={a.publicId}>
                  <ReceiptLink
                    href={`/panel/comprobantes/${a.publicId}`}
                    icon="advance"
                    title={a.numberLabel}
                    detail={dayShort(a.businessDate)}
                    amount={a.amountLabel}
                    reversed={a.status === "reversed"}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function groupByDay(lines: Mine["pending"]["lines"]) {
  const days: { date: string; lines: Mine["pending"]["lines"][number][] }[] = [];
  for (const line of lines) {
    const last = days[days.length - 1];
    if (last && last.date === line.businessDate) last.lines.push(line);
    else days.push({ date: line.businessDate, lines: [line] });
  }
  return days;
}

function ReceiptLink({
  href,
  icon,
  title,
  detail,
  amount,
  reversed,
}: {
  href: string;
  icon: "receipt" | "advance";
  title: string;
  detail: string;
  amount: string;
  reversed: boolean;
}) {
  const Icon = icon === "receipt" ? ReceiptText : HandCoins;
  return (
    <Link
      href={href}
      className="flex min-h-14 items-center gap-3 px-4 py-3 outline-none hover:bg-tinta/[0.03] focus-visible:outline-3 focus-visible:-outline-offset-2 focus-visible:outline-cuero"
    >
      <Icon size={18} className="shrink-0 text-tinta/60" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">
          {title}
          {reversed ? <span className="ml-2 text-xs font-semibold text-tinta/70">({icon === "receipt" ? "revertida" : "revertido"})</span> : null}
        </span>
        <span className="monto block text-xs text-tinta/70">{detail}</span>
      </span>
      <span className={`monto shrink-0 whitespace-nowrap font-semibold ${reversed ? "text-tinta/60 line-through" : ""}`}>{amount}</span>
      <ChevronRight size={16} className="shrink-0 text-tinta/60" aria-hidden />
    </Link>
  );
}
