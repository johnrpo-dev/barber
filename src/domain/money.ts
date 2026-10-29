// Dinero exacto. Regla del proyecto: ningún monto pasa nunca por `number`.
// Se guarda en unidades menores (centavos, exponente ISO 4217 = 2) como bigint,
// igual que la columna `bigint` de PostgreSQL.

export type Currency = "COP";

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

const MINOR_PER_UNIT = 100n;

export function money(minor: bigint, currency: Currency = "COP"): Money {
  return { minor, currency };
}

/** Monto a partir de pesos enteros: fromUnits(25_000n) = $25.000. */
export function fromUnits(units: bigint, currency: Currency = "COP"): Money {
  return money(units * MINOR_PER_UNIT, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Monedas distintas: ${a.currency} y ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency = "COP"): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

/** Divide redondeando la mitad hacia fuera de cero (half-up simétrico). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** Porcentaje en puntos básicos: 4000 = 40 %. */
export function percentOf(amount: Money, basisPoints: bigint): Money {
  return money(divRoundHalfUp(amount.minor * basisPoints, 10_000n), amount.currency);
}

/**
 * Reparte un monto según pesos relativos sin perder ni crear centavos:
 * la suma de las partes es siempre exactamente el total.
 * Los centavos sobrantes van a las partes con mayor residuo.
 */
export function allocate(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new Error("allocate necesita al menos un peso");
  if (weights.some((w) => w < 0n)) throw new Error("Los pesos no pueden ser negativos");
  const total = weights.reduce((a, w) => a + w, 0n);
  if (total === 0n) throw new Error("La suma de pesos no puede ser cero");

  const sign = amount.minor < 0n ? -1n : 1n;
  const abs = amount.minor * sign;
  const parts = weights.map((w) => (abs * w) / total);
  const remainders = weights.map((w, i) => ({ i, r: (abs * w) % total }));
  let leftover = abs - parts.reduce((a, p) => a + p, 0n);

  remainders.sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return parts.map((p) => money(p * sign, amount.currency));
}

const formatters: Record<Currency, Intl.NumberFormat> = {
  COP: new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }),
};

/** Formato para mostrar en pantalla. No usar el resultado para calcular. */
export function format(m: Money): string {
  const negative = m.minor < 0n;
  const abs = negative ? -m.minor : m.minor;
  const decimal = `${negative ? "-" : ""}${abs / MINOR_PER_UNIT}.${(abs % MINOR_PER_UNIT).toString().padStart(2, "0")}`;
  // Intl acepta strings decimales exactos (Intl.NumberFormat v3); el cast solo calma a los tipos.
  return formatters[m.currency].format(decimal as unknown as number);
}
