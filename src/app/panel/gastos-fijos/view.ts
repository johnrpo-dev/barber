import type { DueRecurring } from "@/db/recurring-expenses";
import { type DueStatus, dueStatusLabel, periodLabel, type RecurringPayMode } from "@/domain/expenses/recurring";
import { PESO } from "@/domain/money";
import { moneyLabel } from "@/lib/labels";
import { dayShort } from "../_components/dates";

// Lo que viaja a la interfaz por cada periodo de un gasto fijo que toca (Caja y Gastos fijos). Sin
// "use server": son funciones de armado, no endpoints. El dinero va como texto de pesos enteros.

export interface RecurringDueItem {
  recurringId: string;
  name: string;
  categoryName: string;
  /** Con la categoría desactivada no se puede registrar (el gasto la exige activa): hay que cambiarla en la plantilla. */
  categoryActive: boolean;
  payMode: RecurringPayMode;
  /** Primer día del mes ("2026-11-01"): la clave del periodo. */
  period: string;
  /** "noviembre de 2026" */
  periodLabel: string;
  /** Vencimiento ("2026-11-05") y su etiqueta ("5 nov"). */
  dueDate: string;
  dueLabel: string;
  status: DueStatus;
  /** "Vencido hace 3 días" / "Vence hoy" / "Vence en 2 días" */
  statusLabel: string;
  /** Monto estimado en pesos enteros (texto de dígitos): llena el campo del formulario. */
  estimatedUnits: string;
  estimatedLabel: string;
  /** Descripción sugerida del gasto ("Arriendo · noviembre de 2026"). */
  defaultDescription: string;
}

export function dueItems(items: DueRecurring[]): RecurringDueItem[] {
  return items.flatMap(({ template, due }) =>
    due.map((d) => ({
      recurringId: template.id.toString(),
      name: template.name,
      categoryName: template.categoryName,
      categoryActive: template.categoryActive,
      payMode: template.payMode,
      period: d.period,
      periodLabel: periodLabel(d.period),
      dueDate: d.dueDate,
      dueLabel: dayShort(d.dueDate),
      status: d.status,
      statusLabel: dueStatusLabel(d),
      // Pesos enteros exactos: la base exige estimated_amount % 100 = 0.
      estimatedUnits: (template.estimatedAmount / PESO).toString(),
      estimatedLabel: moneyLabel(template.estimatedAmount),
      defaultDescription: `${template.name} · ${periodLabel(d.period)}`.slice(0, 200),
    })),
  );
}

/** Lo más urgente primero: por fecha de vencimiento (vencidos, hoy, por vencer) y luego por nombre. */
export function sortDue(items: RecurringDueItem[]): RecurringDueItem[] {
  return [...items].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}
