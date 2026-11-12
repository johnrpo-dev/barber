"use server";

import { backupStatus } from "@/db/backup-runs";
import { db } from "@/db/client";
import { countDueToday } from "@/db/inventory";
import { dueRecurringExpenses } from "@/db/recurring-expenses";
import { dashboardData } from "@/db/reports";
import type { Db } from "@/db/types";
import { deliveryStatus } from "@/db/worker-heartbeat";
import { estimatedPayout } from "@/domain/commissions/settlement";
import { money } from "@/domain/money";
import { can } from "@/domain/staff/roles";
import { changeLabel, rateBps } from "@/domain/reports/rates";
import { type ActionResult, runAction } from "@/lib/action";
import { absLabel, atLabel, minorText, moneyLabel } from "@/lib/labels";
import { allowsDevFallbacks } from "@/lib/public-readiness";
import { requirePermission } from "@/lib/session";
import { type BackupLine, backupLines } from "./backup-view";

// Tablero del dueño (docs/sprint-5-comisiones-informes.md §7). Una sola foto de solo lectura.

export type DashboardView = {
  businessDate: string;
  dayClosed: boolean;
  kpis: {
    key: "sales_today" | "services_today" | "profit_month" | "cash";
    label: string;
    valueLabel: string;
    compareLabel: string | null;
    changeLabel: string | null;
    trend: "up" | "down" | "flat" | null;
  }[];
  cash: { open: boolean; openedAtLabel: string | null; openedBy: string | null; expectedLabel: string | null };
  alerts: {
    kind: "cash_review" | "void_pending" | "day_unclosed" | "day_reopened" | "recurring_overdue" | "courtesies" | "inventory_count";
    count: number;
    label: string;
    href: string;
  }[];
  /** Recibos o avisos de la sede en cola y el worker sin latir hace más de 5 minutos (migración 0030). */
  deliveryStalled: boolean;
  /** Último respaldo y última prueba de restauración (migración 0031). Vacío en desarrollo sin backups. */
  backups: BackupLine[];
  owed: { staffId: string; name: string; commissionLabel: string; tipsLabel: string; receivableLabel: string; netMinor: string; netLabel: string }[];
  upcoming: { atLabel: string; staffName: string; serviceName: string; clientName: string | null; status: "pending" | "confirmed" | "arrived" }[];
};

/** Variación contra lo anterior; sin base (0), no hay variación. */
function variation(current: bigint, previous: bigint): { changeLabel: string | null; trend: "up" | "down" | "flat" | null } {
  const bps = rateBps(current - previous, previous < 0n ? -previous : previous);
  if (bps === null) return { changeLabel: null, trend: null };
  return { changeLabel: changeLabel(bps), trend: bps > 0n ? "up" : bps < 0n ? "down" : "flat" };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export async function loadDashboard(): Promise<ActionResult<DashboardView>> {
  const staff = await requirePermission("reports.financial");
  return runAction(async () => {
    const d = await dashboardData(db() as unknown as Db, { locationId: staff.locationId });
    // Gastos fijos vencidos (sprint 8, §5): solo los ya vencidos, no los que vencen en los próximos días.
    const recurring = await dueRecurringExpenses(db() as unknown as Db, { locationId: staff.locationId });
    const overdue = recurring.items.reduce((n, x) => n + x.due.filter((p) => p.status === "overdue").length, 0);
    const delivery = await deliveryStatus(db() as unknown as Db, staff.locationId);
    const now = new Date();
    const backups = backupLines(await backupStatus(db() as unknown as Db, now), {
      timeZone: d.timeZone,
      today: d.businessDate,
      now,
      // Falla cerrado: solo en desarrollo o tests se calla que no haya ningún respaldo.
      production: !allowsDevFallbacks(),
    });
    // Conteo a ciegas: el esperado de un turno abierto solo lo ve quien revisa la caja.
    const expected = can(staff.role, "cash.review") ? d.cash.expected : null;
    const alerts: DashboardView["alerts"] = [];
    if (d.cashReviewCount > 0) {
      alerts.push({
        kind: "cash_review",
        count: d.cashReviewCount,
        label: plural(d.cashReviewCount, "Un turno de caja por revisar", `${d.cashReviewCount} turnos de caja por revisar`),
        href: "/panel/caja",
      });
    }
    if (d.voidPendingCount > 0) {
      alerts.push({
        kind: "void_pending",
        count: d.voidPendingCount,
        label: plural(d.voidPendingCount, "Una anulación pendiente", `${d.voidPendingCount} anulaciones pendientes`),
        href: "/panel/anulaciones",
      });
    }
    if (overdue > 0) {
      alerts.push({
        kind: "recurring_overdue",
        count: overdue,
        label: plural(overdue, "Un gasto fijo vencido sin registrar", `${overdue} gastos fijos vencidos sin registrar`),
        href: "/panel/gastos-fijos",
      });
    }
    // Cortesías (sprint 8, auditoría M1): visibles aquí aunque no haya correo de avisos. Sin las que
    // dio el propio dueño, como el barrido de avisos. El enlace abre el informe de esos 7 días.
    if (d.recentCourtesies.count > 0) {
      const n = d.recentCourtesies.count;
      alerts.push({
        kind: "courtesies",
        count: n,
        label: plural(n, "Una cortesía en los últimos 7 días", `${n} cortesías en los últimos 7 días`),
        href: `/panel/informes?desde=${d.recentCourtesies.from}&hasta=${d.businessDate}#sec-courtesies`,
      });
    }
    // Conteo de inventario (sprint 6, fase D): el último día del mes, mientras no se haya contado. Solo
    // a quien puede contar (inventory.manage); el enlace abre Productos.
    if (can(staff.role, "inventory.manage") && (await countDueToday(db() as unknown as Db, staff.locationId, now))) {
      alerts.push({ kind: "inventory_count", count: 1, label: "Hoy es el último día del mes: toca contar el inventario", href: "/panel/productos" });
    }
    if (d.yesterdayUnclosed) alerts.push({ kind: "day_unclosed", count: 1, label: "Ayer no se cerró el día", href: "/panel/caja" });
    if (d.todayAutoReopen) {
      alerts.push({
        kind: "day_reopened",
        count: d.todayAutoReopen.times,
        label:
          d.todayAutoReopen.times === 1
            ? `Hoy el día estaba cerrado y ${d.todayAutoReopen.by} lo reabrió al abrir la caja`
            : `Hoy se reabrió el día ${d.todayAutoReopen.times} veces al abrir la caja (la última, ${d.todayAutoReopen.by})`,
        href: "/panel/caja",
      });
    }

    return {
      businessDate: d.businessDate,
      dayClosed: d.dayClosed,
      kpis: [
        {
          key: "sales_today",
          label: "Ventas de hoy",
          valueLabel: moneyLabel(d.salesToday),
          compareLabel: `${moneyLabel(d.salesLastWeek)} la semana pasada`,
          ...variation(d.salesToday, d.salesLastWeek),
        },
        {
          key: "services_today",
          label: "Servicios atendidos hoy",
          valueLabel: d.servicesToday.toString(),
          compareLabel: `${d.servicesLastWeek} la semana pasada`,
          ...variation(BigInt(d.servicesToday), BigInt(d.servicesLastWeek)),
        },
        {
          key: "profit_month",
          label: "Utilidad del mes",
          valueLabel: moneyLabel(d.profitMonth),
          compareLabel: `${moneyLabel(d.profitPreviousMonth)} el mes pasado a esta fecha`,
          ...variation(d.profitMonth, d.profitPreviousMonth),
        },
        {
          key: "cash",
          label: "Efectivo en caja",
          valueLabel: expected !== null ? moneyLabel(expected) : d.cash.open ? "Abierta" : "Caja cerrada",
          compareLabel: null,
          changeLabel: null,
          trend: null,
        },
      ],
      cash: {
        open: d.cash.open,
        openedAtLabel: d.cash.openedAt && atLabel(d.cash.openedAt, d.timeZone, d.businessDate),
        openedBy: d.cash.openedBy,
        expectedLabel: expected === null ? null : moneyLabel(expected),
      },
      alerts,
      deliveryStalled: delivery.stalled,
      backups,
      owed: d.owed.map((b) => {
        const net = estimatedPayout({
          commission: money(b.pendingCommission),
          clawbacks: money(b.clawbacks),
          tipsOwed: money(b.tipsOwed),
          receivable: money(b.receivable),
        }).minor;
        return {
          staffId: b.staffId.toString(),
          name: b.name,
          commissionLabel: moneyLabel(b.commissionOwed),
          tipsLabel: moneyLabel(b.tipsOwed),
          receivableLabel: absLabel(b.receivable),
          netMinor: minorText(net),
          netLabel: moneyLabel(net),
        };
      }),
      upcoming: d.upcoming.map((u) => ({
        atLabel: atLabel(u.at, d.timeZone, d.businessDate),
        staffName: u.staffName,
        serviceName: u.serviceName,
        clientName: u.clientName,
        status: u.status,
      })),
    };
  });
}
