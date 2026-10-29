import { ACCOUNTS, type AccountCode } from "../ledger/accounts";
import type { JournalEntryDraft, LedgerLine } from "../ledger/entry";
import { allocate, CENTAVO, type Money, money, PESO, percentOf, subtract, sum } from "../money";

// Cobro de una venta (docs/sprint-4-cobro-caja.md §1 y §3). Funciones puras: calculan líneas,
// comisiones congeladas, cambio y costo del datáfono, y arman el asiento. La base de datos
// vuelve a exigir el cuadre al hacer COMMIT.

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export type PaymentKind = "cash" | "card" | "transfer" | "wallet";

export interface CheckoutRules {
  /** Sobre qué se calcula la comisión: el precio después del descuento (neto) o antes (bruto). */
  readonly commissionBase: "net" | "gross";
  /** Tope del descuento por línea, en puntos básicos del precio (3000 = 30 %). */
  readonly maxDiscountBps: bigint;
  /** Si la propina pagada con medios electrónicos asume su parte del costo del datáfono. */
  readonly tipsBearCardFees: boolean;
}

export const DEFAULT_CHECKOUT_RULES: CheckoutRules = {
  commissionBase: "net",
  maxDiscountBps: 3_000n,
  tipsBearCardFees: false,
};

export interface CheckoutLineInput {
  readonly staffId: bigint;
  readonly description: string;
  readonly unitPrice: Money;
  readonly discount: Money;
  readonly discountReason?: string;
  readonly commissionBps: bigint;
}

export interface PaymentInput {
  readonly methodId: bigint;
  readonly kind: PaymentKind;
  /** Lo que se aplica a la venta. En efectivo es lo que queda en la caja (entregado − cambio). */
  readonly amount: Money;
  /** Solo efectivo: lo que entregó el cliente. */
  readonly tendered?: Money;
  /** Costo del medio en puntos básicos (datáfono, pasarela). El efectivo siempre es 0. */
  readonly feeBps: bigint;
}

export interface TipInput {
  readonly staffId: bigint;
  readonly amount: Money;
}

export interface CheckoutInput {
  readonly lines: readonly CheckoutLineInput[];
  readonly payments: readonly PaymentInput[];
  readonly tips: readonly TipInput[];
}

export interface PricedLine extends CheckoutLineInput {
  readonly net: Money;
  /** Comisión congelada: half-up al peso, una sola vez por línea (ADR-001). */
  readonly commission: Money;
}

export interface PricedPayment extends PaymentInput {
  /** Solo efectivo: entregado − aplicado. */
  readonly change: Money;
  /** Costo del datáfono de este pago: half-up al centavo, una sola vez. */
  readonly fee: Money;
}

export interface PricedTip extends TipInput {
  /** Parte del datáfono que asume esta propina (0 si la regla no lo pide). Se congela en sale_tips. */
  readonly feeShare: Money;
  /** Lo que se le debe al barbero: propina − feeShare. La suma de todos es el crédito a 2380. */
  readonly payable: Money;
}

export interface Checkout {
  readonly lines: readonly PricedLine[];
  readonly payments: readonly PricedPayment[];
  readonly tips: readonly PricedTip[];
  readonly subtotal: Money;
  readonly discount: Money;
  readonly netTotal: Money;
  readonly tipsTotal: Money;
  /** Lo que paga el cliente: neto + propinas = suma de los pagos aplicados. */
  readonly totalDue: Money;
  readonly commissionTotal: Money;
  readonly feesTotal: Money;
  /** Parte del datáfono que asume el negocio (gasto 5305). */
  readonly businessFees: Money;
  /** Parte del datáfono que asumen las propinas (reduce lo que se debe a los barberos). */
  readonly tipFees: Money;
}

const zero = (m: Money) => money(0n, m.currency);
const MAX_BPS = 10_000n;
/** Tope sano por monto: $100.000 millones. Muy por encima de una venta real y lejos del límite de bigint. */
export const MAX_AMOUNT_MINOR = 10n ** 13n;
export const MAX_LINES = 20;
export const MAX_PAYMENTS = 5;
export const MAX_TIPS = 10;

function assertAmount(m: Money, what: string, opts: { wholePesos: boolean }) {
  if (m.minor < 0n) throw new CheckoutError(`${what} no puede ser negativo`);
  if (m.minor > MAX_AMOUNT_MINOR) throw new CheckoutError(`${what} es demasiado grande`);
  // Precios, descuentos, propinas y efectivo van en pesos enteros: el efectivo no tiene centavos.
  if (opts.wholePesos && m.minor % PESO !== 0n) throw new CheckoutError(`${what} debe ir en pesos enteros`);
}

function assertBps(bps: bigint, what: string, max: bigint = MAX_BPS) {
  if (bps < 0n || bps > max) throw new CheckoutError(`${what} debe estar entre 0 % y ${formatBps(max)}`);
}

/** 2550n → "25,5 %" (solo para mensajes). */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `,${frac}` : ""} %`;
}

/** Calcula la venta completa o lanza CheckoutError con un mensaje para el usuario. */
export function priceCheckout(input: CheckoutInput, rules: CheckoutRules = DEFAULT_CHECKOUT_RULES): Checkout {
  if (input.lines.length === 0) throw new CheckoutError("La venta no tiene servicios");
  if (input.lines.length > MAX_LINES || input.payments.length > MAX_PAYMENTS || input.tips.length > MAX_TIPS) {
    throw new CheckoutError("La venta tiene demasiadas líneas, pagos o propinas");
  }
  assertBps(rules.maxDiscountBps, "El tope de descuento");

  const lines: PricedLine[] = input.lines.map((line) => {
    assertAmount(line.unitPrice, "El precio", { wholePesos: true });
    assertAmount(line.discount, "El descuento", { wholePesos: true });
    assertBps(line.commissionBps, "La comisión");
    if (!line.description.trim()) throw new CheckoutError("Cada servicio necesita una descripción");
    if (line.discount.minor > line.unitPrice.minor) throw new CheckoutError("El descuento no puede superar el precio");
    // Comparación exacta (sin redondear): descuento / precio ≤ tope.
    if (line.discount.minor * MAX_BPS > line.unitPrice.minor * rules.maxDiscountBps) {
      throw new CheckoutError(`El descuento supera el tope permitido (${formatBps(rules.maxDiscountBps)})`);
    }
    if (line.discount.minor > 0n && !line.discountReason?.trim()) {
      throw new CheckoutError("Escribe el motivo del descuento");
    }
    const net = subtract(line.unitPrice, line.discount);
    const base = rules.commissionBase === "net" ? net : line.unitPrice;
    return { ...line, net, commission: percentOf(base, line.commissionBps, PESO) };
  });

  const currency = lines[0]!.unitPrice.currency;
  for (const tip of input.tips) {
    assertAmount(tip.amount, "La propina", { wholePesos: true });
    if (tip.amount.minor <= 0n) throw new CheckoutError("Una propina debe ser mayor que cero");
  }
  const tipStaff = new Set(input.tips.map((t) => t.staffId));
  if (tipStaff.size !== input.tips.length) throw new CheckoutError("Hay dos propinas para la misma persona");

  const subtotal = sum(lines.map((l) => l.unitPrice), currency);
  const discount = sum(lines.map((l) => l.discount), currency);
  const netTotal = sum(lines.map((l) => l.net), currency);
  const tipsTotal = sum(input.tips.map((t) => t.amount), currency);
  const totalDue = sum([netTotal, tipsTotal], currency);
  if (totalDue.minor <= 0n) throw new CheckoutError("No hay nada que cobrar");

  const methods = new Set(input.payments.map((p) => p.methodId));
  if (methods.size !== input.payments.length) throw new CheckoutError("Hay dos pagos con el mismo medio");

  const payments: PricedPayment[] = input.payments.map((p) => {
    if (p.amount.minor <= 0n) throw new CheckoutError("Cada pago debe ser mayor que cero");
    if (p.kind === "cash") {
      assertAmount(p.amount, "El efectivo", { wholePesos: true });
      if (p.feeBps !== 0n) throw new CheckoutError("El efectivo no tiene costo de datáfono");
      const tendered = p.tendered ?? p.amount;
      assertAmount(tendered, "El efectivo entregado", { wholePesos: true });
      if (tendered.minor < p.amount.minor) throw new CheckoutError("El efectivo entregado no alcanza");
      return { ...p, tendered, change: subtract(tendered, p.amount), fee: zero(p.amount) };
    }
    // Un pago electrónico puede llevar centavos (sale de repartir un total); el costo nunca es todo el pago.
    assertAmount(p.amount, "El pago", { wholePesos: false });
    assertBps(p.feeBps, "El costo del medio de pago", MAX_BPS - 1n);
    if (p.tendered) throw new CheckoutError("Solo el efectivo lleva valor entregado");
    const fee = percentOf(p.amount, p.feeBps, CENTAVO);
    if (fee.minor >= p.amount.minor) throw new CheckoutError("El costo del medio de pago no puede ser todo el pago");
    return { ...p, change: zero(p.amount), fee };
  });

  const paid = sum(payments.map((p) => p.amount), currency);
  if (paid.minor !== totalDue.minor) {
    throw new CheckoutError(paid.minor < totalDue.minor ? "Falta dinero por cobrar" : "Los pagos superan el total");
  }

  const feesTotal = sum(payments.map((p) => p.fee), currency);
  // Los pagos no se atribuyen a líneas: el dinero es fungible. Por eso, si las propinas asumen
  // datáfono, el costo total se reparte entre venta y propinas en proporción a lo cobrado
  // (decisión en docs/sprint-4-cobro-caja.md §1). Como cada costo es menor que su pago,
  // feesTotal < totalDue y ninguna parte se come entera su base salvo por un centavo de reparto,
  // que se rechaza abajo.
  const [businessFees, tipFees] =
    rules.tipsBearCardFees && tipsTotal.minor > 0n && feesTotal.minor > 0n
      ? (allocate(feesTotal, [netTotal.minor, tipsTotal.minor]) as [Money, Money])
      : [feesTotal, zero(feesTotal)];
  const tipShares = tipFees.minor > 0n ? allocate(tipFees, input.tips.map((t) => t.amount.minor)) : input.tips.map((t) => zero(t.amount));
  const tips: PricedTip[] = input.tips.map((t, i) => ({ ...t, feeShare: tipShares[i]!, payable: subtract(t.amount, tipShares[i]!) }));
  if (tips.some((t) => t.payable.minor <= 0n)) throw new CheckoutError("El costo del medio de pago se come una propina completa");

  return {
    lines,
    payments,
    tips,
    subtotal,
    discount,
    netTotal,
    tipsTotal,
    totalDue,
    commissionTotal: sum(lines.map((l) => l.commission), currency),
    feesTotal,
    businessFees,
    tipFees,
  };
}

/** Suma por cuenta con signo (débito +, crédito −) y emite una línea por cuenta, sin ceros. */
function linesFrom(postings: readonly [AccountCode, bigint][], currency: Money["currency"]): LedgerLine[] {
  const net = new Map<AccountCode, bigint>();
  for (const [account, signed] of postings) net.set(account, (net.get(account) ?? 0n) + signed);
  const lines: LedgerLine[] = [];
  for (const [account, signed] of net) {
    if (signed === 0n) continue;
    lines.push({ account, side: signed > 0n ? "debit" : "credit", amount: money(signed > 0n ? signed : -signed, currency) });
  }
  return lines;
}

/** Asiento de la venta: dinero recibido, datáfono, ingreso neto, propinas por pagar y comisión causada. */
export function saleEntry(
  checkout: Checkout,
  meta: { businessDate: string; memo: string; idempotencyKey?: string },
): JournalEntryDraft {
  const currency = checkout.totalDue.currency;
  const cash = sum(checkout.payments.filter((p) => p.kind === "cash").map((p) => p.amount), currency);
  const electronic = sum(checkout.payments.filter((p) => p.kind !== "cash").map((p) => p.amount), currency);
  const lines = linesFrom(
    [
      [ACCOUNTS.cash.code, cash.minor],
      [ACCOUNTS.bank.code, electronic.minor - checkout.feesTotal.minor],
      [ACCOUNTS.cardFees.code, checkout.businessFees.minor],
      [ACCOUNTS.serviceIncome.code, -checkout.netTotal.minor],
      [ACCOUNTS.tipsPayable.code, -(checkout.tipsTotal.minor - checkout.tipFees.minor)],
      [ACCOUNTS.commissionExpense.code, checkout.commissionTotal.minor],
      [ACCOUNTS.commissionsPayable.code, -checkout.commissionTotal.minor],
    ],
    currency,
  );
  return { businessDate: meta.businessDate, kind: "sale", memo: meta.memo, lines, idempotencyKey: meta.idempotencyKey };
}
