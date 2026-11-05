import { sql } from "drizzle-orm";
import type { ReportQuery } from "./reports";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Historial del dueño (sprint 6): ventas día por día y las aperturas y cierres de caja de un
// periodo. Todo se suma en SQL (CLAUDE.md); la app solo da formato. Sin datos de clientes.

const loc = (q: { locationId: bigint }) => sql`${q.locationId}::bigint`;
const inRange = (column: ReturnType<typeof sql>, q: ReportQuery) => sql`${column} between ${q.from}::date and ${q.to}::date`;

export interface SalesDayRow {
  /** null en la fila del total del periodo. */
  businessDate: string | null;
  paid: number;
  voided: number;
  /** Cobrado (servicios − descuentos + propinas) de las ventas vigentes. */
  total: bigint;
  tips: bigint;
  cash: bigint;
  /** Lo cobrado por los demás medios (tarjeta, transferencia, billeteras). */
  other: bigint;
}

/**
 * Una fila por día contable con ventas, más la del total (la última, con businessDate null). Las
 * anuladas se cuentan aparte y no suman en los montos.
 */
export async function salesByDay(db: Db, q: ReportQuery): Promise<{ days: SalesDayRow[]; total: SalesDayRow }> {
  const rows = rowsOf<{ business_date: string | null; paid: number; voided: number; total: string; tips: string; cash: string; other: string }>(
    await db.execute(sql`
      select s.business_date::text as business_date,
             count(*) filter (where s.status = 'paid')::int as paid,
             count(*) filter (where s.status = 'voided')::int as voided,
             coalesce(sum(s.total_paid) filter (where s.status = 'paid'), 0)::text as total,
             coalesce(sum(s.tips) filter (where s.status = 'paid'), 0)::text as tips,
             coalesce(sum(p.cash) filter (where s.status = 'paid'), 0)::text as cash,
             coalesce(sum(p.other) filter (where s.status = 'paid'), 0)::text as other
        from sales s
        -- Los pagos de CADA venta del periodo (no de toda la sede): el costo crece con el periodo.
        left join lateral (
          select sum(sp.amount) filter (where sp.kind = 'cash') as cash,
                 sum(sp.amount) filter (where sp.kind <> 'cash') as other
            from sale_payments sp
           where sp.location_id = s.location_id and sp.sale_id = s.id
        ) p on true
       where s.location_id = ${loc(q)} and ${inRange(sql`s.business_date`, q)}
       group by grouping sets ((s.business_date), ())
       order by grouping(s.business_date), s.business_date desc
    `),
  );
  const map = (r: (typeof rows)[number]): SalesDayRow => ({
    businessDate: r.business_date,
    paid: Number(r.paid),
    voided: Number(r.voided),
    total: BigInt(r.total),
    tips: BigInt(r.tips),
    cash: BigInt(r.cash),
    other: BigInt(r.other),
  });
  const all = rows.map(map);
  const total = all.find((r) => r.businessDate === null) ?? { businessDate: null, paid: 0, voided: 0, total: 0n, tips: 0n, cash: 0n, other: 0n };
  return { days: all.filter((r) => r.businessDate !== null), total };
}

export interface SaleDetailRow {
  publicId: string;
  businessDate: string;
  /** Hora local de la sede, "HH:MM". */
  time: string;
  status: "paid" | "voided";
  services: string;
  staff: string;
  subtotal: bigint;
  discount: bigint;
  tips: bigint;
  total: bigint;
  cash: bigint;
  other: bigint;
  /** Medios usados, sin repetir: "Efectivo, Nequi". */
  methods: string;
}

/** Cada venta del periodo, para exportar (de la más antigua a la más reciente). */
export async function salesDetail(db: Db, q: ReportQuery & { limit: number }): Promise<SaleDetailRow[]> {
  const rows = rowsOf<{
    public_id: string;
    business_date: string;
    time: string;
    status: "paid" | "voided";
    services: string | null;
    staff: string | null;
    subtotal: string;
    discount: string;
    tips: string;
    total: string;
    cash: string;
    other: string;
    methods: string | null;
  }>(
    await db.execute(sql`
      select s.public_id, s.business_date::text as business_date,
             to_char(s.created_at at time zone l.timezone, 'HH24:MI') as time,
             s.status, s.subtotal::text, s.discount::text, s.tips::text, s.total_paid::text as total,
             (select string_agg(sl.description, ', ' order by sl.position)
                from sale_lines sl where sl.location_id = s.location_id and sl.sale_id = s.id) as services,
             (select string_agg(x.name, ', ' order by x.first)
                from (select m.display_name as name, min(sl.position) as first
                        from sale_lines sl
                        join staff_members m on m.location_id = sl.location_id and m.id = sl.staff_id
                       where sl.location_id = s.location_id and sl.sale_id = s.id
                       group by m.display_name) x) as staff,
             coalesce((select sum(sp.amount) from sale_payments sp
                        where sp.location_id = s.location_id and sp.sale_id = s.id and sp.kind = 'cash'), 0)::text as cash,
             coalesce((select sum(sp.amount) from sale_payments sp
                        where sp.location_id = s.location_id and sp.sale_id = s.id and sp.kind <> 'cash'), 0)::text as other,
             (select string_agg(distinct sp.label, ', ')
                from sale_payments sp where sp.location_id = s.location_id and sp.sale_id = s.id) as methods
        from sales s
        join locations l on l.id = s.location_id
       where s.location_id = ${loc(q)} and ${inRange(sql`s.business_date`, q)}
       order by s.business_date, s.created_at, s.id
       limit ${q.limit}
    `),
  );
  return rows.map((r) => ({
    publicId: r.public_id,
    businessDate: r.business_date,
    time: r.time,
    status: r.status,
    services: r.services ?? "",
    staff: r.staff ?? "",
    subtotal: BigInt(r.subtotal),
    discount: BigInt(r.discount),
    tips: BigInt(r.tips),
    total: BigInt(r.total),
    cash: BigInt(r.cash),
    other: BigInt(r.other),
    methods: r.methods ?? "",
  }));
}

export interface CashSessionRow {
  id: bigint;
  /** Día local de la sede en que se abrió. */
  openedDate: string;
  openedTime: string;
  openedBy: string;
  openingCounted: bigint;
  /** Contado − libro al abrir: positivo sobra, negativo falta. */
  openingDifference: bigint;
  openingNote: string | null;
  closedDate: string | null;
  closedTime: string | null;
  closedBy: string | null;
  expected: bigint | null;
  closingCounted: bigint | null;
  difference: bigint | null;
  closingNote: string | null;
  /** Fue a revisión del dueño (apertura o cierre fuera del umbral). */
  flagged: boolean;
  reviewed: boolean;
  reviewedBy: string | null;
}

/**
 * Turnos de caja abiertos en el periodo (por el día local de la apertura), del más reciente al más
 * antiguo, y la suma de las diferencias de apertura y de cierre.
 */
export async function cashSessionsInPeriod(db: Db, q: ReportQuery): Promise<{ sessions: CashSessionRow[]; openingDifference: bigint; closingDifference: bigint }> {
  const rows = rowsOf<{
    id: string;
    opened_date: string;
    opened_time: string;
    opened_by: string | null;
    opening_counted: string;
    opening_difference: string;
    opening_note: string | null;
    closed_date: string | null;
    closed_time: string | null;
    closed_by: string | null;
    expected: string | null;
    closing_counted: string | null;
    difference: string | null;
    closing_note: string | null;
    flagged: boolean;
    reviewed: boolean;
    reviewed_by: string | null;
    sum_opening: string;
    sum_closing: string;
  }>(
    await db.execute(sql`
      select cs.id::text,
             (cs.opened_at at time zone l.timezone)::date::text as opened_date,
             to_char(cs.opened_at at time zone l.timezone, 'HH24:MI') as opened_time,
             mo.display_name as opened_by,
             cs.opening_counted::text,
             (cs.opening_counted - cs.opening_expected)::text as opening_difference,
             cs.opening_note,
             (cs.closed_at at time zone l.timezone)::date::text as closed_date,
             to_char(cs.closed_at at time zone l.timezone, 'HH24:MI') as closed_time,
             mc.display_name as closed_by,
             cs.expected_cash::text as expected,
             cs.closing_counted::text,
             cs.difference::text,
             cs.note as closing_note,
             (cs.needs_review or cs.opening_needs_review) as flagged,
             cs.reviewed_at is not null as reviewed,
             mr.display_name as reviewed_by,
             sum(cs.opening_counted - cs.opening_expected) over ()::text as sum_opening,
             coalesce(sum(cs.difference) over (), 0)::text as sum_closing
        from cash_sessions cs
        join locations l on l.id = cs.location_id
        left join staff_members mo on mo.location_id = cs.location_id and mo.user_id = cs.opened_by
        left join staff_members mc on mc.location_id = cs.location_id and mc.user_id = cs.closed_by
        left join staff_members mr on mr.location_id = cs.location_id and mr.user_id = cs.reviewed_by
       where cs.location_id = ${loc(q)} and ${inRange(sql`(cs.opened_at at time zone l.timezone)::date`, q)}
         -- Cota por instantes, con un día de margen a cada lado por la zona: descarta turnos viejos sin calcular su fecha local.
         and cs.opened_at >= ${q.from}::date - 1 and cs.opened_at < ${q.to}::date + 2
       order by cs.opened_at desc, cs.id desc
       limit 50001
    `),
  );
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return {
    sessions: rows.map((r) => ({
      id: BigInt(r.id),
      openedDate: r.opened_date,
      openedTime: r.opened_time,
      openedBy: r.opened_by ?? "Personal",
      openingCounted: BigInt(r.opening_counted),
      openingDifference: BigInt(r.opening_difference),
      openingNote: r.opening_note,
      closedDate: r.closed_date,
      closedTime: r.closed_time,
      closedBy: r.closed_date === null ? null : (r.closed_by ?? "Personal"),
      expected: big(r.expected),
      closingCounted: big(r.closing_counted),
      difference: big(r.difference),
      closingNote: r.closing_note,
      flagged: r.flagged,
      reviewed: r.reviewed,
      reviewedBy: r.reviewed_by,
    })),
    openingDifference: BigInt(rows[0]?.sum_opening ?? "0"),
    closingDifference: BigInt(rows[0]?.sum_closing ?? "0"),
  };
}
