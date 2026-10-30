import { ACCOUNTS } from "../ledger/accounts";
import type { PaymentKind } from "./checkout";

// Lo que trae una sede nueva (docs/sprint-4-cobro-caja.md §1 y §2). Son sugerencias que el dueño
// edita en Ajustes. La migración 0010 siembra lo mismo en las sedes que ya existían.

/** El costo del datáfono empieza en 0 hasta que el dueño lo ponga [confirmar]. */
export const DEFAULT_PAYMENT_METHODS: readonly { kind: PaymentKind; label: string; feeBps: number }[] = [
  { kind: "cash", label: "Efectivo", feeBps: 0 },
  { kind: "card", label: "Tarjeta", feeBps: 0 },
  { kind: "transfer", label: "Transferencia", feeBps: 0 },
  { kind: "wallet", label: "Nequi/Daviplata", feeBps: 0 },
];

/** Todas a Gastos generales (5195) hasta que el contador defina el mapeo. */
export const DEFAULT_EXPENSE_CATEGORIES: readonly { name: string; accountCode: string }[] = [
  "Arriendo",
  "Servicios públicos",
  "Insumos",
  "Aseo",
  "Mantenimiento",
  "Publicidad",
  "Otros",
].map((name) => ({ name, accountCode: ACCOUNTS.generalExpense.code }));

export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  wallet: "Billetera",
};
