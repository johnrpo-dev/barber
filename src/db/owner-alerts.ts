import { and, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { money } from "@/domain/money";
import { type OwnerAlertItem, type OwnerAlertKind, ownerAlertMessage } from "@/domain/notifications/owner-alert";
import { windowStart } from "@/domain/security/rate-limit";
import { describeError } from "@/lib/log";
import { REOPEN_ON_CASH_OPEN_REASON } from "./cash";
import { hit } from "./rate-limit";
import { ownerAlerts } from "./schema";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Avisos al dueño por correo (sprint 8, docs/sprint-8-gastos-controles.md §3, migración 0027).
// 1. sweepOwnerAlerts: cada minuto, el worker copia a owner_alerts lo que el dueño debe saber de los
//    últimos 2 días, leyendo las tablas que ya existen. Idempotente: INSERT … SELECT … ON CONFLICT DO
//    NOTHING sobre UNIQUE (location_id, kind, ref_id). No toca el camino del dinero (ni cash.ts, ni
//    voids.ts, ni triggers en esas tablas): solo lee.
// 2. deliverOwnerAlerts: a lo sumo UN correo por sede cada 15 minutos con todo lo pendiente, como
//    deliverSecurityAlerts. notified_at se marca SOLO si el correo salió. Sin correo configurado no se
//    marca nada: los avisos esperan y el dueño los sigue viendo en Inicio.

/** Lo que se barre hacia atrás. Más viejo que esto ya no se avisa (lo ve en Inicio). */
export const OWNER_ALERT_LOOKBACK_MS = 2 * 86_400_000;
/** Como mucho un correo de avisos por sede cada 15 minutos. */
export const OWNER_ALERT_WINDOW_SEC = 15 * 60;

export type OwnerAlertSend = (subject: string, text: string, idempotencyKey: string) => Promise<void>;
/** Con qué se envía: Resend a ALERT_EMAIL y la URL pública para los enlaces. null: sin correo. */
export type OwnerAlertTransport = { send: OwnerAlertSend; baseUrl: string };

/**
 * Copia a owner_alerts los eventos de los últimos 2 días que aún no tienen aviso. Devuelve cuántos
 * avisos nuevos creó (0 si se repite).
 * - void_requested: solicitud de anulación aún pendiente. La aprobada o rechazada no se avisa: la
 *   decide el dueño.
 * - cash_review: turno cerrado que la base marcó para revisión (needs_review u opening_needs_review,
 *   con el umbral de la sede) y que nadie ha revisado todavía. Siempre, aunque lo cierre el dueño:
 *   el descuadre importa igual.
 * - day_reopened: reapertura de un día contable (manual o al abrir la caja).
 * - courtesy: cortesía.
 * La solicitud, la reapertura y la cortesía NO se avisan si las hizo una cuenta con rol de dueño en
 * esa sede (staff_members.role = 'owner'): el dueño no necesita un correo de lo que hizo él mismo.
 */
/** ¿La cuenta (user_id) es dueño en esa sede? El rol vive en staff_members, por sede. */
const byOwner = (locationId: SQL, userId: SQL) =>
  sql`exists (select 1 from staff_members sm where sm.location_id = ${locationId} and sm.user_id = ${userId} and sm.role = 'owner')`;

export async function sweepOwnerAlerts(db: Db, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - OWNER_ALERT_LOOKBACK_MS).toISOString();
  const rows = rowsOf<{ id: unknown }>(
    await db.execute(sql`
      insert into owner_alerts (location_id, kind, ref_id)
      select s.location_id, s.kind, s.ref_id from (
        select v.location_id, 'void_requested' as kind, v.id as ref_id
          from void_requests v
         where v.status = 'pending' and v.created_at >= ${since}::timestamptz
           and not ${byOwner(sql`v.location_id`, sql`v.requested_by`)}
        union all
        select cs.location_id, 'cash_review', cs.id
          from cash_sessions cs
         where (cs.needs_review or cs.opening_needs_review) and cs.closed_at is not null
           and cs.reviewed_at is null and cs.closed_at >= ${since}::timestamptz
        union all
        select e.location_id, 'day_reopened', e.id
          from day_close_events e
         where e.action = 'reopen' and e.created_at >= ${since}::timestamptz
           and not ${byOwner(sql`e.location_id`, sql`e.created_by`)}
        union all
        select c.location_id, 'courtesy', c.id
          from appointment_courtesies c
         where c.created_at >= ${since}::timestamptz
           and not ${byOwner(sql`c.location_id`, sql`c.created_by`)}
      ) s
      order by s.location_id, s.kind, s.ref_id
      on conflict (location_id, kind, ref_id) do nothing
      returning id
    `),
  );
  return rows.length;
}

interface PendingRow {
  id: string;
  location_id: string;
  kind: OwnerAlertKind;
  location_name: string;
  time_zone: string;
  at: Date | string | null;
  by: string | null;
  /** La fuente ya no pide nada: la anulación se decidió o el turno se revisó. */
  resolved: boolean;
  amount: string | null;
  closing_difference: string | null;
  opening_counted: string | null;
  opening_expected: string | null;
  opening_flagged: boolean | null;
  closing_flagged: boolean | null;
  business_date: string | null;
  reopen_on_cash_open: boolean | null;
  service_name: string | null;
  staff_name: string | null;
}

/** Los avisos sin entregar, con lo que el correo necesita de su fila de origen. Sin motivos ni clientes. */
async function pendingRows(db: Db, limit: number): Promise<PendingRow[]> {
  return rowsOf<PendingRow>(
    await db.execute(sql`
      select a.id::text as id, a.location_id::text as location_id, a.kind,
             l.name as location_name, l.timezone as time_zone,
             case a.kind when 'void_requested' then v.created_at when 'cash_review' then cs.closed_at
                         when 'day_reopened' then e.created_at else c.created_at end as at,
             m.display_name as by,
             case a.kind when 'void_requested' then v.status is distinct from 'pending'
                         when 'cash_review' then cs.reviewed_at is not null else false end as resolved,
             (case a.kind when 'void_requested' then s.total_paid when 'courtesy' then c.list_price end)::text as amount,
             cs.difference::text as closing_difference,
             cs.opening_counted::text as opening_counted,
             cs.opening_expected::text as opening_expected,
             cs.opening_needs_review as opening_flagged,
             cs.needs_review as closing_flagged,
             e.business_date::text as business_date,
             (e.reason = ${REOPEN_ON_CASH_OPEN_REASON}) as reopen_on_cash_open,
             ap.service_name,
             ms.display_name as staff_name
        from owner_alerts a
        join locations l on l.id = a.location_id
        left join void_requests v on a.kind = 'void_requested' and v.location_id = a.location_id and v.id = a.ref_id
        left join sales s on s.location_id = v.location_id and s.id = v.sale_id
        left join cash_sessions cs on a.kind = 'cash_review' and cs.location_id = a.location_id and cs.id = a.ref_id
        left join day_close_events e on a.kind = 'day_reopened' and e.location_id = a.location_id and e.id = a.ref_id
        left join appointment_courtesies c on a.kind = 'courtesy' and c.location_id = a.location_id and c.id = a.ref_id
        left join appointments ap on ap.location_id = c.location_id and ap.id = c.appointment_id
        left join staff_members ms on ms.location_id = c.location_id and ms.id = c.staff_id
        left join lateral (
          select sm.display_name from staff_members sm
           where sm.location_id = a.location_id
             and sm.user_id = case a.kind when 'void_requested' then v.requested_by when 'cash_review' then cs.closed_by
                                          when 'day_reopened' then e.created_by else c.created_by end
           order by sm.id limit 1
        ) m on true
       where a.notified_at is null
       order by a.location_id, a.id
       limit ${limit}
    `),
  );
}

const big = (v: string | null): bigint => BigInt(v ?? "0");

function toItem(r: PendingRow): OwnerAlertItem {
  const at = new Date(r.at ?? 0);
  switch (r.kind) {
    case "void_requested":
      return { kind: r.kind, at, by: r.by, amount: money(big(r.amount)) };
    case "cash_review":
      return {
        kind: r.kind,
        at,
        by: r.by,
        closingDifference: r.closing_flagged && r.closing_difference !== null ? money(big(r.closing_difference)) : null,
        // contado − libro al abrir; la resta va por bigint (sin number), como en money.ts.
        openingDifference: r.opening_flagged ? money(big(r.opening_counted) - big(r.opening_expected)) : null,
      };
    case "day_reopened":
      return { kind: r.kind, at, by: r.by, businessDate: r.business_date ?? "", onCashOpen: r.reopen_on_cash_open === true };
    case "courtesy":
      return { kind: r.kind, at, by: r.by, amount: money(big(r.amount)), serviceName: r.service_name ?? "Servicio", staffName: r.staff_name };
  }
}

export interface OwnerAlertDelivery {
  /** Avisos que quedaron sin entregar después de esta pasada. */
  pending: number;
  /** Avisos incluidos en correos que salieron. */
  delivered: number;
  emails: number;
  /** Correos que fallaron (sus avisos quedan pendientes para la ventana siguiente). */
  failed: number;
  /** Por correo enviado: la sede y los avisos que cubrió (los ya resueltos se marcan con él, sin listarse). */
  batches: { locationId: bigint; alertIds: bigint[] }[];
}

/**
 * Cada minuto (worker): por sede, si hay avisos sin entregar y no salió otro correo en esta ventana
 * de 15 minutos, manda UN correo con todos y los marca. Si el envío falla, quedan pendientes para la
 * ventana siguiente. Sin transporte (sin correo configurado) no marca nada.
 * Los avisos cuya fuente ya se resolvió antes del envío (anulación decidida, turno revisado) no van
 * en el correo: se marcan junto con el correo de su sede o, si no queda nada más que avisar, solos.
 */
export async function deliverOwnerAlerts(
  db: Db,
  transport: OwnerAlertTransport | null,
  opts: { now?: Date; limit?: number } = {},
): Promise<OwnerAlertDelivery> {
  const now = opts.now ?? new Date();
  const rows = await pendingRows(db, opts.limit ?? 500);
  const result: OwnerAlertDelivery = { pending: rows.length, delivered: 0, emails: 0, failed: 0, batches: [] };
  if (rows.length === 0 || !transport) return result;

  const byLocation = new Map<string, PendingRow[]>();
  for (const r of rows) byLocation.set(r.location_id, [...(byLocation.get(r.location_id) ?? []), r]);

  const window = windowStart(now, OWNER_ALERT_WINDOW_SEC);
  for (const [location, group] of byLocation) {
    const locationId = BigInt(location);
    const live = group.filter((r) => !r.resolved);
    const ids = group.map((r) => BigInt(r.id));
    if (live.length === 0) {
      await markNotified(db, ids, now);
      result.pending -= ids.length;
      continue;
    }
    // El contador de límites es la bandera "ya salió un correo de esta sede en esta ventana".
    if ((await hit(db, `alert:owner:${location}`, window)) !== 1) continue;
    const first = group[0]!;
    const { subject, text } = ownerAlertMessage(live.map(toItem), {
      locationName: first.location_name,
      timeZone: first.time_zone,
      baseUrl: transport.baseUrl,
    });
    try {
      await transport.send(subject, text, `alert:owner:${location}:${ids[0]}-${ids.at(-1)}`);
    } catch (err) {
      // Sin el texto del correo ni el destinatario: solo la sede y el error sin parámetros.
      console.error("[avisos] no salió el correo de avisos al dueño", { locationId: location, ...describeError(err) });
      result.failed += 1;
      continue;
    }
    await markNotified(db, ids, now);
    result.pending -= ids.length;
    result.delivered += live.length;
    result.emails += 1;
    result.batches.push({ locationId, alertIds: live.map((r) => BigInt(r.id)) });
  }
  return result;
}

async function markNotified(db: Db, ids: bigint[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(ownerAlerts)
    .set({ notifiedAt: now })
    .where(and(inArray(ownerAlerts.id, ids), isNull(ownerAlerts.notifiedAt)));
}
