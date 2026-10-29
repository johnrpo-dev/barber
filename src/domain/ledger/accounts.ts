// Plan de cuentas mínimo de una sede. Códigos inspirados en el PUC colombiano:
// el contador de Villa debe validarlos antes de exportar a contabilidad formal.

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** Lado en que la cuenta aumenta. */
export type NormalSide = "debit" | "credit";

export interface AccountDefinition {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
}

export const ACCOUNTS = {
  cash: { code: "1105", name: "Caja (efectivo)", type: "asset" },
  bank: { code: "1110", name: "Bancos y billeteras (tarjeta, transferencia)", type: "asset" },
  commissionsPayable: { code: "2335", name: "Comisiones por pagar a barberos", type: "liability" },
  tipsPayable: { code: "2380", name: "Propinas por pagar a barberos", type: "liability" },
  ownerEquity: { code: "3105", name: "Capital del dueño", type: "equity" },
  serviceIncome: { code: "4170", name: "Ingresos por servicios", type: "income" },
  productIncome: { code: "4135", name: "Ingresos por venta de productos", type: "income" },
  commissionExpense: { code: "5105", name: "Comisiones de barberos", type: "expense" },
  generalExpense: { code: "5195", name: "Gastos generales", type: "expense" },
  cardFees: { code: "5305", name: "Comisiones de datáfono y pasarelas", type: "expense" },
  cashDifferences: { code: "5310", name: "Diferencias y redondeos de caja", type: "expense" },
} as const satisfies Record<string, AccountDefinition>;

export type AccountKey = keyof typeof ACCOUNTS;
export type AccountCode = (typeof ACCOUNTS)[AccountKey]["code"];

export const CHART_OF_ACCOUNTS: readonly AccountDefinition[] = Object.values(ACCOUNTS);

export function normalSide(type: AccountType): NormalSide {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}
