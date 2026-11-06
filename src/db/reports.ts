import { type SQL, sql } from "drizzle-orm";
import type { AccountType } from "@/domain/ledger/accounts";
import { addDays } from "@/domain/booking/clock";
import { sameDayLastWeek, sameSpanPreviousMonth } from "@/domain/reports/period";
import type { AccountTotalRow, PnlTotals } from "@/domain/reports/pnl";
import type { PaymentKind } from "@/domain/sales/checkout";
import { REOPEN_ON_CASH_OPEN_REASON, today } from "./cash";
import { commissionBalances, type StaffBalances } from "./commissions";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Informes y tablero (docs/sprint-5-comisiones-informes.md §6 y §7). Todo se suma EN SQL y viaja como
// texto de centavos; aquí solo se convierte a bigint. Rangos por día contable, inclusive.

export interface ReportQuery {
  locationId: bigint;
  from: string;
  to: string;
}

/** Todas las secciones salen de la misma foto: REPEATABLE READ de solo lectura. */
export function readOnlySnapshot<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db), { isolationLevel: "repeatable read", accessMode: "read only" });
}

const big = (v: string | null | undefined): bigint => BigInt(v ?? "0");
const inRange = (column: SQL, q: ReportQuery) => sql`${column} between ${q.from}::date and ${q.to}::date`;
const loc = (q: { locationId: bigint }) => sql`${q.locationId}::bigint`;

/**
 * Lo que cada venta aporta a cada día contable del rango: +1 el día en que se cobró (vigente o
 * anulada después) y −1 el día de su anulación (el de la reversa en el libro). Los informes de
 * ventas multiplican por `sign`: así suman lo mismo que el libro en CUALQUIER rango, aunque la venta
 * sea de un día y la anulación de otro. Columnas: location_id, sale_id, business_date, sign.
 */
export function saleEffects(q: ReportQuery): SQL {
  return sql`(
    select s.location_id, s.id as sale_id, s.business_date, 1 as sign
      from sales s
     where s.location_id = ${loc(q)} and ${inRange(sql`s.business_date`, q)}
    union all
    select s.location_id, s.id as sale_id, e.business_date, -1 as sign
      from journal_entries e
      join sales s on s.location_id = e.location_id and s.void_entry_id = e.id
     where e.location_id = ${loc(q)} and e.kind = 'reversal' and ${inRange(sql`e.business_date`, q)}
  )`;
}

export async function profitAndLoss(db: Db, q: ReportQuery): Promise<{ rows: AccountTotalRow[]; totals: PnlTotals }> {
  const rows = rowsOf<{ code: string | null; name: string | null; type: string | null; debits: string | null; credits: string | null; net: string | null; g_code: number; g_type: number }>(
    await db.execute(sql`
      select a.code, a.name, a.type, sum(l.debit)::text as debits, sum(l.credit)::text as credits,
             sum(l.credit - l.debit)::text as net, grouping(a.code, a.name)::int as g_code, grouping(a.type)::int as g_type
        from journal_lines l
        join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
        join accounts a on a.location_id = l.location_id and a.id = l.account_id
       where l.location_id = ${loc(q)} and ${inRange(sql`e.business_date`, q)} and a.type in ('income', 'expense')
       group by grouping sets ((a.type, a.code, a.name), (a.type), ())
    `),
  );
  const detail = rows.filter((r) => Number(r.g_code) === 0);
  const income = rows.find((r) => Number(r.g_code) !== 0 && Number(r.g_type) === 0 && r.type === "income");
  const expense = rows.find((r) => Number(r.g_code) !== 0 && Number(r.g_type) === 0 && r.type === "expense");
  const grand = rows.find((r) => Number(r.g_type) !== 0);
  return {
    rows: detail.map((r) => ({ code: r.code!, name: r.name!, type: r.type as AccountType, debits: big(r.debits), credits: big(r.credits) })),
    totals: { income: big(income?.net), expenses: -big(expense?.net), profit: big(grand?.net) },
  };
}

export async function salesByStaff(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ staff_id: string; name: string; services: string; gross: string; discount: string; net: string; commission: string; tips: string }>(
    await db.execute(sql`
      with lines as (
        select l.staff_id, sum(f.sign) as services, sum(f.sign * l.unit_price) as gross, sum(f.sign * l.discount) as discount,
               sum(f.sign * l.net) as net, sum(f.sign * l.commission) as commission
          from ${saleEffects(q)} f join sale_lines l on l.location_id = f.location_id and l.sale_id = f.sale_id
         where l.location_id = ${loc(q)}
         group by l.staff_id
        -- Fuera solo lo que se anula en TODAS las columnas (una venta y su anulación en el rango).
        having sum(f.sign) <> 0 or sum(f.sign * l.unit_price) <> 0 or sum(f.sign * l.discount) <> 0
            or sum(f.sign * l.net) <> 0 or sum(f.sign * l.commission) <> 0
      ), tips as (
        select t.staff_id, sum(f.sign * t.amount) as tips
          from ${saleEffects(q)} f join sale_tips t on t.location_id = f.location_id and t.sale_id = f.sale_id
         where t.location_id = ${loc(q)}
         group by t.staff_id
        having sum(f.sign * t.amount) <> 0
      )
      select m.id::text as staff_id, m.display_name as name, coalesce(l.services, 0)::text as services,
             coalesce(l.gross, 0)::text as gross, coalesce(l.discount, 0)::text as discount, coalesce(l.net, 0)::text as net,
             coalesce(l.commission, 0)::text as commission, coalesce(t.tips, 0)::text as tips
        from staff_members m
        left join lines l on l.staff_id = m.id
        left join tips t on t.staff_id = m.id
       where m.location_id = ${loc(q)} and (l.staff_id is not null or t.staff_id is not null)
       order by coalesce(l.net, 0) desc, m.display_name, m.id
    `),
  );
  return rows.map((r) => ({
    staffId: BigInt(r.staff_id),
    name: r.name,
    services: Number(r.services),
    gross: BigInt(r.gross),
    discount: BigInt(r.discount),
    net: BigInt(r.net),
    commission: BigInt(r.commission),
    tips: BigInt(r.tips),
  }));
}

export async function salesByService(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ service_id: string; name: string; services: string; gross: string; discount: string; net: string; commission: string; total_net: string }>(
    await db.execute(sql`
      select sv.id::text as service_id, sv.name, sum(f.sign)::text as services, sum(f.sign * l.unit_price)::text as gross,
             sum(f.sign * l.discount)::text as discount, sum(f.sign * l.net)::text as net, sum(f.sign * l.commission)::text as commission,
             sum(sum(f.sign * l.net)) over ()::text as total_net
        from ${saleEffects(q)} f
        join sale_lines l on l.location_id = f.location_id and l.sale_id = f.sale_id
        join services sv on sv.location_id = l.location_id and sv.id = l.service_id
       where l.location_id = ${loc(q)}
       group by sv.id, sv.name
      having sum(f.sign) <> 0 or sum(f.sign * l.unit_price) <> 0 or sum(f.sign * l.discount) <> 0
          or sum(f.sign * l.net) <> 0 or sum(f.sign * l.commission) <> 0
       order by sum(f.sign * l.net) desc, sv.name, sv.id
    `),
  );
  return rows.map((r) => ({
    serviceId: BigInt(r.service_id),
    name: r.name,
    services: Number(r.services),
    gross: BigInt(r.gross),
    discount: BigInt(r.discount),
    net: BigInt(r.net),
    commission: BigInt(r.commission),
    /** Neto de todo el periodo: el denominador de la participación. */
    totalNet: BigInt(r.total_net),
  }));
}

export async function paymentMix(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ kind: PaymentKind; label: string; payments: string; amount: string; fees: string; total_amount: string }>(
    await db.execute(sql`
      select p.kind, p.label, sum(f.sign)::text as payments, sum(f.sign * p.amount)::text as amount, sum(f.sign * p.fee)::text as fees,
             sum(sum(f.sign * p.amount)) over ()::text as total_amount
        from ${saleEffects(q)} f join sale_payments p on p.location_id = f.location_id and p.sale_id = f.sale_id
       where p.location_id = ${loc(q)}
       group by p.kind, p.label
      having sum(f.sign) <> 0 or sum(f.sign * p.amount) <> 0 or sum(f.sign * p.fee) <> 0
       order by sum(f.sign * p.amount) desc, p.label
    `),
  );
  return rows.map((r) => ({ kind: r.kind, label: r.label, payments: Number(r.payments), amount: BigInt(r.amount), fees: BigInt(r.fees), totalAmount: BigInt(r.total_amount) }));
}

/** Causadas por día de la venta (menos las anuladas, el día de la anulación); pagadas por día del pago (Caja + liquidaciones vigentes). */
export async function tipsByStaff(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ staff_id: string; name: string; tips: string; fee_share: string; payable: string; paid_out: string; total_tips: string }>(
    await db.execute(sql`
      with earned as (
        select t.staff_id, sum(f.sign * t.amount) as tips, sum(f.sign * t.fee_share) as fee_share, sum(f.sign * t.payable) as payable
          from ${saleEffects(q)} f join sale_tips t on t.location_id = f.location_id and t.sale_id = f.sale_id
         where t.location_id = ${loc(q)}
         group by t.staff_id
        having sum(f.sign * t.amount) <> 0 or sum(f.sign * t.fee_share) <> 0 or sum(f.sign * t.payable) <> 0
      ), paid as (
        select staff_id, sum(amount) as paid_out from (
          select m.staff_id, jl.debit - jl.credit as amount
            from cash_movements m
            join journal_entries e on e.location_id = m.location_id and e.id = m.journal_entry_id
            join journal_lines jl on jl.location_id = m.location_id and jl.entry_id = m.journal_entry_id
            join accounts a on a.location_id = jl.location_id and a.id = jl.account_id
           where m.location_id = ${loc(q)} and m.kind = 'tip_payout' and a.code = '2380' and ${inRange(sql`e.business_date`, q)}
          union all
          select st.staff_id, c.amount
            from commission_settlement_lines c
            join commission_settlements st on st.location_id = c.location_id and st.id = c.settlement_id
           where c.location_id = ${loc(q)} and c.kind = 'tips' and not c.reversed and ${inRange(sql`st.business_date`, q)}
        ) x group by staff_id
      )
      select sm.id::text as staff_id, sm.display_name as name, coalesce(e.tips, 0)::text as tips, coalesce(e.fee_share, 0)::text as fee_share,
             coalesce(e.payable, 0)::text as payable, coalesce(p.paid_out, 0)::text as paid_out,
             sum(coalesce(e.tips, 0)) over ()::text as total_tips
        from staff_members sm
        left join earned e on e.staff_id = sm.id
        left join paid p on p.staff_id = sm.id
       where sm.location_id = ${loc(q)} and (e.staff_id is not null or p.staff_id is not null)
       order by sm.display_name, sm.id
    `),
  );
  return rows.map((r) => ({
    staffId: BigInt(r.staff_id),
    name: r.name,
    tips: BigInt(r.tips),
    feeShare: BigInt(r.fee_share),
    payable: BigInt(r.payable),
    paidOut: BigInt(r.paid_out),
    totalTips: BigInt(r.total_tips),
  }));
}

async function accountNet(db: Db, q: ReportQuery, code: string): Promise<bigint> {
  const [row] = rowsOf<{ net: string }>(
    await db.execute(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as net
        from journal_lines l
        join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
        join accounts a on a.location_id = l.location_id and a.id = l.account_id
       where l.location_id = ${loc(q)} and a.code = ${code} and ${inRange(sql`e.business_date`, q)}
    `),
  );
  return big(row?.net);
}

export async function cardFees(db: Db, q: ReportQuery): Promise<{ ledgerTotal: bigint; byMethod: { label: string; fees: bigint }[]; absorbedByTips: bigint }> {
  const ledgerTotal = await accountNet(db, q, "5305");
  const rows = rowsOf<{ label: string; fees: string }>(
    await db.execute(sql`
      select p.label, sum(f.sign * p.fee)::text as fees
        from ${saleEffects(q)} f join sale_payments p on p.location_id = f.location_id and p.sale_id = f.sale_id
       where p.location_id = ${loc(q)} and p.fee > 0
       group by p.label
      having sum(f.sign * p.fee) <> 0
       order by sum(f.sign * p.fee) desc, p.label
    `),
  );
  // Con "las propinas asumen el datáfono", esta parte del costo sale de 2380 y no llega a 5305:
  // Σ medios − esto = cuenta 5305 (docs/sprint-5-comisiones-informes.md §6).
  const [absorbed] = rowsOf<{ total: string }>(
    await db.execute(sql`
      select coalesce(sum(f.sign * t.fee_share), 0)::text as total
        from ${saleEffects(q)} f join sale_tips t on t.location_id = f.location_id and t.sale_id = f.sale_id
       where t.location_id = ${loc(q)}
    `),
  );
  return { ledgerTotal, byMethod: rows.map((r) => ({ label: r.label, fees: BigInt(r.fees) })), absorbedByTips: BigInt(absorbed!.total) };
}

export async function expensesByCategory(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ category_id: string; name: string; paid_from: "cash" | "bank"; count: string; amount: string }>(
    await db.execute(sql`
      select c.id::text as category_id, c.name, x.paid_from, count(*)::text as count, sum(x.amount)::text as amount
        from expenses x join expense_categories c on c.location_id = x.location_id and c.id = x.category_id
       where x.location_id = ${loc(q)} and ${inRange(sql`x.business_date`, q)}
       group by c.id, c.name, x.paid_from
       order by sum(x.amount) desc, c.name, x.paid_from
    `),
  );
  return rows.map((r) => ({ categoryId: BigInt(r.category_id), name: r.name, paidFrom: r.paid_from, count: Number(r.count), amount: BigInt(r.amount) }));
}

/** `net` y `difference`: positivo = sobrante; negativo = faltante (contado − esperado). */
export async function cashDifferences(db: Db, q: ReportQuery) {
  const net = -(await accountNet(db, q, "5310"));
  const rows = rowsOf<{ business_date: string; moment: "opening" | "closing"; difference: string; note: string | null; by: string | null }>(
    await db.execute(sql`
      select e.business_date::text as business_date, 'opening' as moment, (cs.opening_counted - cs.opening_expected)::text as difference,
             cs.opening_note as note, m.display_name as by, e.id as entry_id
        from cash_sessions cs
        join journal_entries e on e.location_id = cs.location_id and e.id = cs.opening_entry_id
        left join staff_members m on m.location_id = cs.location_id and m.user_id = cs.opened_by
       where cs.location_id = ${loc(q)} and ${inRange(sql`e.business_date`, q)}
      union all
      select e.business_date::text, 'closing', cs.difference::text, cs.note, m.display_name, e.id
        from cash_sessions cs
        join journal_entries e on e.location_id = cs.location_id and e.id = cs.closing_entry_id
        left join staff_members m on m.location_id = cs.location_id and m.user_id = cs.closed_by
       where cs.location_id = ${loc(q)} and ${inRange(sql`e.business_date`, q)}
       order by entry_id
    `),
  );
  return {
    net,
    items: rows.map((r) => ({ businessDate: r.business_date, moment: r.moment, difference: BigInt(r.difference), note: r.note, by: r.by ?? "Personal" })),
  };
}

export interface NoShowRow {
  reservations: number;
  completed: number;
  noShow: number;
  cancelled: number;
  lateCancelled: number;
}

/** Citas reservadas (no walk-in) que empiezan en el rango; sin las retenciones vencidas. */
export async function noShowStats(db: Db, q: ReportQuery & { timeZone: string }): Promise<{ total: NoShowRow; byStaff: (NoShowRow & { staffId: bigint; name: string })[] }> {
  const rows = rowsOf<{
    staff_id: string | null;
    name: string | null;
    reservations: string;
    completed: string;
    no_show: string;
    cancelled: string;
    late_cancelled: string;
    g: number;
  }>(
    await db.execute(sql`
      select a.staff_id::text as staff_id, m.display_name as name,
             count(*)::text as reservations,
             count(*) filter (where a.status = 'completed')::text as completed,
             count(*) filter (where a.status = 'no_show')::text as no_show,
             count(*) filter (where a.status = 'cancelled')::text as cancelled,
             count(*) filter (where a.status = 'cancelled' and a.cancelled_late)::text as late_cancelled,
             grouping(a.staff_id, m.display_name)::int as g
        from appointments a
        join staff_members m on m.location_id = a.location_id and m.id = a.staff_id
       where a.location_id = ${loc(q)} and a.source <> 'walk_in'
         and (a.status <> 'cancelled' or a.cancel_reason is distinct from 'expired')
         and lower(a.during) >= ((${q.from}::date)::timestamp at time zone ${q.timeZone})
         and lower(a.during) < (((${q.to}::date + 1))::timestamp at time zone ${q.timeZone})
       group by grouping sets ((a.staff_id, m.display_name), ())
    `),
  );
  const toRow = (r: (typeof rows)[number] | undefined): NoShowRow => ({
    reservations: Number(r?.reservations ?? 0),
    completed: Number(r?.completed ?? 0),
    noShow: Number(r?.no_show ?? 0),
    cancelled: Number(r?.cancelled ?? 0),
    lateCancelled: Number(r?.late_cancelled ?? 0),
  });
  return {
    total: toRow(rows.find((r) => Number(r.g) !== 0)),
    byStaff: rows
      .filter((r) => Number(r.g) === 0)
      .map((r) => ({ ...toRow(r), staffId: BigInt(r.staff_id!), name: r.name! }))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
  };
}

/**
 * Cortesías del periodo por quien atendió (sprint 8, §4): cuántas y su precio de lista sumado, por
 * el día contable en que se dieron. No es dinero del libro: lo que el negocio dejó de cobrar.
 */
export async function courtesiesByStaff(db: Db, q: ReportQuery) {
  const rows = rowsOf<{ staff_id: string; name: string; courtesies: string; list_price: string; total_courtesies: string; total_list_price: string }>(
    await db.execute(sql`
      select m.id::text as staff_id, m.display_name as name, count(*)::text as courtesies, sum(c.list_price)::text as list_price,
             sum(count(*)) over ()::text as total_courtesies, sum(sum(c.list_price)) over ()::text as total_list_price
        from appointment_courtesies c
        join staff_members m on m.location_id = c.location_id and m.id = c.staff_id
       where c.location_id = ${loc(q)} and ${inRange(sql`c.business_date`, q)}
       group by m.id, m.display_name
       order by sum(c.list_price) desc, m.display_name, m.id
    `),
  );
  return {
    rows: rows.map((r) => ({ staffId: BigInt(r.staff_id), name: r.name, courtesies: Number(r.courtesies), listPrice: BigInt(r.list_price) })),
    total: { courtesies: Number(rows[0]?.total_courtesies ?? 0), listPrice: big(rows[0]?.total_list_price) },
  };
}

export interface SettlementSummaryRow {
  publicId: string;
  number: bigint;
  staffName: string;
  cutoffDate: string;
  businessDate: string;
  payout: bigint;
  paidFrom: "cash" | "bank" | null;
  status: "settled" | "reversed";
}

export async function settlementsInPeriod(db: Db, q: ReportQuery): Promise<SettlementSummaryRow[]> {
  const rows = rowsOf<{ public_id: string; number: string; name: string; cutoff_date: string; business_date: string; payout: string; paid_from: "cash" | "bank" | null; status: "settled" | "reversed" }>(
    await db.execute(sql`
      select st.public_id, st.number::text as number, m.display_name as name, st.cutoff_date::text as cutoff_date,
             st.business_date::text as business_date, st.payout::text as payout, st.paid_from, st.status
        from commission_settlements st
        join staff_members m on m.location_id = st.location_id and m.id = st.staff_id
       where st.location_id = ${loc(q)} and ${inRange(sql`st.business_date`, q)}
       order by st.number desc
    `),
  );
  return rows.map((r) => ({
    publicId: r.public_id,
    number: BigInt(r.number),
    staffName: r.name,
    cutoffDate: r.cutoff_date,
    businessDate: r.business_date,
    payout: BigInt(r.payout),
    paidFrom: r.paid_from,
    status: r.status,
  }));
}

export interface JournalDetailRow {
  businessDate: string;
  entryId: bigint;
  kind: string;
  memo: string;
  code: string;
  accountName: string;
  debit: bigint;
  credit: bigint;
}

/** Libro diario para el contador. `limit`: pedir uno más que el tope para detectar que se pasó. */
export async function journalDetail(db: Db, q: ReportQuery & { limit: number }): Promise<JournalDetailRow[]> {
  const rows = rowsOf<{ business_date: string; entry_id: string; kind: string; memo: string; code: string; name: string; debit: string; credit: string }>(
    await db.execute(sql`
      select e.business_date::text as business_date, e.id::text as entry_id, e.kind, e.memo, a.code, a.name,
             l.debit::text as debit, l.credit::text as credit
        from journal_lines l
        join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
        join accounts a on a.location_id = l.location_id and a.id = l.account_id
       where l.location_id = ${loc(q)} and ${inRange(sql`e.business_date`, q)}
       order by e.business_date, e.id, l.id
       limit ${q.limit}
    `),
  );
  return rows.map((r) => ({
    businessDate: r.business_date,
    entryId: BigInt(r.entry_id),
    kind: r.kind,
    memo: r.memo,
    code: r.code,
    accountName: r.name,
    debit: BigInt(r.debit),
    credit: BigInt(r.credit),
  }));
}

// ─── Tablero ─────────────────────────────────────────────────────────────────

export interface DashboardData {
  businessDate: string;
  dayClosed: boolean;
  timeZone: string;
  salesToday: bigint;
  salesLastWeek: bigint;
  servicesToday: number;
  servicesLastWeek: number;
  profitMonth: bigint;
  profitPreviousMonth: bigint;
  cash: { open: boolean; openedAt: Date | null; openedBy: string | null; expected: bigint | null };
  cashReviewCount: number;
  voidPendingCount: number;
  yesterdayUnclosed: boolean;
  /** Hoy se reabrió el día al abrir la caja: quién (la última vez) y cuántas veces. */
  todayAutoReopen: { by: string; times: number } | null;
  owed: StaffBalances[];
  upcoming: { at: Date; staffName: string; serviceName: string; clientName: string | null; status: "pending" | "confirmed" | "arrived" }[];
}

async function incomeOfDay(db: Db, locationId: bigint, day: string): Promise<bigint> {
  const [row] = rowsOf<{ net: string }>(
    await db.execute(sql`
      select coalesce(sum(l.credit - l.debit), 0)::text as net
        from journal_lines l
        join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
        join accounts a on a.location_id = l.location_id and a.id = l.account_id
       where l.location_id = ${locationId}::bigint and e.business_date = ${day}::date and a.code in ('4170', '4135')
    `),
  );
  return big(row?.net);
}

async function servicesOfDay(db: Db, locationId: bigint, day: string): Promise<number> {
  const [row] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select coalesce(sum(f.sign), 0)::text as n
        from ${saleEffects({ locationId, from: day, to: day })} f
        join sale_lines l on l.location_id = f.location_id and l.sale_id = f.sale_id
       where l.location_id = ${locationId}::bigint
    `),
  );
  return Number(row?.n ?? "0");
}

async function profitOf(db: Db, q: ReportQuery): Promise<bigint> {
  const [row] = rowsOf<{ net: string }>(
    await db.execute(sql`
      select coalesce(sum(l.credit - l.debit), 0)::text as net
        from journal_lines l
        join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
        join accounts a on a.location_id = l.location_id and a.id = l.account_id
       where l.location_id = ${loc(q)} and a.type in ('income', 'expense') and ${inRange(sql`e.business_date`, q)}
    `),
  );
  return big(row?.net);
}

/** Una sola foto de solo lectura. */
export async function dashboardData(db: Db, input: { locationId: bigint; now?: Date }): Promise<DashboardData> {
  const now = input.now ?? new Date();
  return readOnlySnapshot(db, async (tx) => {
    const { locationId } = input;
    const day = await today(tx, locationId, now);
    const lastWeek = sameDayLastWeek(day.businessDate);
    const monthStart = `${day.businessDate.slice(0, 7)}-01`;
    const previousSpan = sameSpanPreviousMonth(day.businessDate);
    const yesterday = addDays(day.businessDate, -1);

    const [session] = rowsOf<{ opened_at: Date | string; name: string | null }>(
      await tx.execute(sql`
        select cs.opened_at, m.display_name as name
          from cash_sessions cs left join staff_members m on m.location_id = cs.location_id and m.user_id = cs.opened_by
         where cs.location_id = ${locationId}::bigint and cs.closed_at is null
      `),
    );
    const [cashRow] = rowsOf<{ net: string }>(
      await tx.execute(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as net
          from journal_lines l join accounts a on a.location_id = l.location_id and a.id = l.account_id
         where l.location_id = ${locationId}::bigint and a.code = '1105'
      `),
    );
    const [alerts] = rowsOf<{ reviews: string; voids: string; unclosed: boolean }>(
      await tx.execute(sql`
        select
          (select count(*) from cash_sessions cs
            where cs.location_id = ${locationId}::bigint and (cs.needs_review or cs.opening_needs_review) and cs.reviewed_at is null)::text as reviews,
          (select count(*) from void_requests v where v.location_id = ${locationId}::bigint and v.status = 'pending')::text as voids,
          (exists (select 1 from journal_entries e where e.location_id = ${locationId}::bigint and e.business_date = ${yesterday}::date)
            and not ledger_day_is_closed(${locationId}::bigint, ${yesterday}::date)) as unclosed
      `),
    );
    const [reopen] = rowsOf<{ by: string | null; times: number }>(
      await tx.execute(sql`
        select (array_agg(m.display_name order by e.id desc))[1] as by, count(*)::int as times
          from day_close_events e
          left join staff_members m on m.location_id = e.location_id and m.user_id = e.created_by
         where e.location_id = ${locationId}::bigint and e.business_date = ${day.businessDate}::date
           and e.action = 'reopen' and e.reason = ${REOPEN_ON_CASH_OPEN_REASON}
        having count(*) > 0
      `),
    );
    const upcoming = rowsOf<{ at: Date | string; staff_name: string; service_name: string; client_name: string | null; status: "pending" | "confirmed" | "arrived" }>(
      await tx.execute(sql`
        select lower(a.during) as at, m.display_name as staff_name, a.service_name, c.name as client_name, a.status
          from appointments a
          join staff_members m on m.location_id = a.location_id and m.id = a.staff_id
          left join clients c on c.location_id = a.location_id and c.id = a.client_id
         where a.location_id = ${locationId}::bigint and a.status in ('pending', 'confirmed', 'arrived')
           and lower(a.during) >= ${now.toISOString()}::timestamptz
           and lower(a.during) < ((${day.businessDate}::date + 1)::timestamp at time zone ${day.timeZone})
         order by lower(a.during), a.id
         limit 5
      `),
    );
    const balances = await commissionBalances(tx, locationId);

    return {
      businessDate: day.businessDate,
      dayClosed: day.closed,
      timeZone: day.timeZone,
      salesToday: await incomeOfDay(tx, locationId, day.businessDate),
      salesLastWeek: await incomeOfDay(tx, locationId, lastWeek),
      servicesToday: await servicesOfDay(tx, locationId, day.businessDate),
      servicesLastWeek: await servicesOfDay(tx, locationId, lastWeek),
      profitMonth: await profitOf(tx, { locationId, from: monthStart, to: day.businessDate }),
      profitPreviousMonth: await profitOf(tx, { locationId, ...previousSpan }),
      cash: session
        ? { open: true, openedAt: new Date(session.opened_at), openedBy: session.name ?? "Personal", expected: big(cashRow?.net) }
        : { open: false, openedAt: null, openedBy: null, expected: null },
      cashReviewCount: Number(alerts?.reviews ?? "0"),
      voidPendingCount: Number(alerts?.voids ?? "0"),
      yesterdayUnclosed: alerts?.unclosed === true,
      todayAutoReopen: reopen ? { by: reopen.by ?? "Personal", times: Number(reopen.times) } : null,
      owed: balances.filter((b) => b.commissionOwed !== 0n || b.tipsOwed !== 0n || b.receivable !== 0n),
      upcoming: upcoming.map((u) => ({ at: new Date(u.at), staffName: u.staff_name, serviceName: u.service_name, clientName: u.client_name, status: u.status })),
    };
  });
}
