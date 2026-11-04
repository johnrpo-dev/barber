// Tasas para mostrar (docs/sprint-5-comisiones-informes.md §6.2 y §7). Enteros exactos: nunca `number`.

/** part / total en puntos básicos, half-up; null si total = 0. Para conteos (inasistencias). */
export function rateBps(part: bigint, total: bigint): bigint | null {
  if (total === 0n) return null;
  const negative = part < 0n !== total < 0n;
  const n = part < 0n ? -part : part;
  const d = total < 0n ? -total : total;
  const q = (n * 20_000n + d) / (2n * d);
  return negative ? -q : q;
}

/** 1250n → "12,5 %"; −305n → "-3,05 %". Solo para mostrar. */
export function bpsLabel(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const frac = (abs % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / 100n}${frac ? `,${frac}` : ""} %`;
}

/** Variación con signo: "+12,5 %", "-3 %", "0 %". */
export function changeLabel(bps: bigint): string {
  return bps > 0n ? `+${bpsLabel(bps)}` : bpsLabel(bps);
}
