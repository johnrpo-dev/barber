// Intervalos semiabiertos [inicio, fin) en milisegundos UTC, igual que tstzrange '[)' en Postgres:
// 10:00–10:30 y 10:30–11:00 no se cruzan.

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export function interval(start: Date, end: Date): Interval {
  return { start: start.getTime(), end: end.getTime() };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function overlapsAny(a: Interval, list: readonly Interval[]): boolean {
  return list.some((b) => overlaps(a, b));
}

/** Ordena y une intervalos que se cruzan o se tocan. */
export function merge(list: readonly Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, cur.end) };
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Primer instante ≥ `from` en que cabe un intervalo de `length` ms sin cruzar `busy`. */
export function nextFreeStart(from: number, length: number, busy: readonly Interval[]): number {
  let start = from;
  for (const b of merge(busy)) {
    if (b.end <= start) continue;
    if (b.start >= start + length) break;
    start = b.end;
  }
  return start;
}
