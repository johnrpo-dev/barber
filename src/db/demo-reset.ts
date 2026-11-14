import { sql } from "drizzle-orm";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// "Empezar de cero" SOLO en la base de la demo (docs/demo.md). Vacía la operación (citas, clientes,
// ventas, caja, libro, compras, proveedores, anticipos, bitácora…) y conserva la configuración (sede,
// servicios, productos, personal, cuentas de acceso, medios de pago, categorías y plantillas de gastos
// fijos), para volver a practicar desde el primer día sin rehacer la base.
//
// En la base real de la barbería esto NO puede pasar, por cinco candados independientes:
//   1. la app solo muestra el botón y la acción solo corre con VILLA_DEMO=1 (lo pone `npm run demo`);
//   2. la base debe llamarse villa_demo (la de la barbería se llama distinto);
//   3. la sesión debe ser superusuario: en el servidor la app es villa_app, que no lo es y no puede
//      saltarse los triggers que prohíben borrar el libro (session_replication_role);
//   4. la base no debe tener respaldos registrados: la de producción los tiene desde el primer día;
//   5. la conexión debe ser local (localhost o socket): la demo corre en el computador de quien presenta.
// El libro contable sigue siendo solo-inserción: aquí no se corrige nada, se descarta la base de práctica.

export const DEMO_DATABASE = "villa_demo";

/** Lo que se conserva: configuración y acceso. */
export const RESET_KEEP = [
  "account",
  "accounts",
  "backup_runs",
  "expense_categories",
  "inventory_locks",
  "locations",
  "payment_methods",
  "products",
  "recurring_expenses",
  "services",
  "session",
  "staff_members",
  "staff_schedules",
  "staff_services",
  "two_factor",
  "user",
  "verification",
] as const;

/** Lo que se vacía: la operación. Ninguna tabla de RESET_KEEP apunta a estas (lo revisa la prueba). */
export const RESET_WIPE = [
  "appointment_courtesies",
  "appointment_events",
  "appointment_links",
  "appointments",
  "audit_events",
  "booking_verifications",
  "cash_movements",
  "cash_sessions",
  "client_consents",
  "client_devices",
  "clients",
  "commission_settlement_lines",
  "commission_settlements",
  "day_close_events",
  "expenses",
  "inventory_document_lines",
  "inventory_documents",
  "journal_entries",
  "journal_lines",
  "login_throttles",
  "notification_events",
  "notifications",
  "owner_alerts",
  "personal_data_reads",
  "rate_limit_counters",
  "recurring_expense_runs",
  "sale_lines",
  "sale_payments",
  "sale_tips",
  "sales",
  "security_alerts",
  "staff_advances",
  "staff_presence_events",
  "supplier_payments",
  "suppliers",
  "time_off",
  "void_requests",
  "worker_heartbeats",
] as const;

export class DemoResetError extends Error {}

/** La app corre en modo demo: solo entonces existe el botón (candado 1; el resto lo revisa la base). */
export function demoResetEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VILLA_DEMO === "1";
}

/**
 * Vacía la operación de la base de la demo, en una sola transacción: o queda todo vacío o no cambia
 * nada. Rechaza cualquier base que no cumpla los candados 2 a 4, y también si aparece una tabla que
 * no esté en RESET_KEEP ni en RESET_WIPE (una tabla nueva se clasifica a conciencia, no por omisión).
 * Los contadores (número de recibo, etc.) vuelven a empezar.
 */
export async function resetDemoData(db: Db, opts: { databaseName?: string } = {}): Promise<{ tables: number }> {
  const expected = opts.databaseName ?? DEMO_DATABASE;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [who] = rowsOf<{ database: string; superuser: boolean; addr: string | null }>(
      await tx.execute(
        sql`select current_database() as database, (select rolsuper from pg_roles where rolname = current_user) as superuser, host(inet_server_addr()) as addr`,
      ),
    );
    if (!who || who.database !== expected) throw new DemoResetError("Solo se puede borrar la base de la demo");
    if (!who.superuser) throw new DemoResetError("Solo se puede borrar la base de la demo (la sesión no es la de la demo)");
    // La demo corre en este computador: conexión por localhost o por socket (sin dirección).
    if (who.addr !== null && who.addr !== "127.0.0.1" && who.addr !== "::1") throw new DemoResetError("Solo se puede borrar una base de la demo en este computador");
    // Sin respaldos, y que nadie registre uno entre esta revisión y el borrado.
    await tx.execute(sql`lock table backup_runs in share mode`);
    const [backups] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from backup_runs`));
    if (Number(backups?.n ?? 0) > 0) throw new DemoResetError("Esta base tiene respaldos registrados: parece la de la barbería. No se borra.");

    const tables = rowsOf<{ name: string }>(
      await tx.execute(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`),
    ).map((t) => t.name);
    const known = new Set<string>([...RESET_KEEP, ...RESET_WIPE]);
    const unknown = tables.filter((t) => !known.has(t));
    if (unknown.length > 0) throw new DemoResetError(`Tablas sin clasificar en demo-reset.ts: ${unknown.join(", ")}`);
    const wipe = RESET_WIPE.filter((t) => tables.includes(t));

    // Los triggers que prohíben borrar el libro y la agenda son la protección de producción; en la
    // base de práctica se saltan solo dentro de esta transacción (SET LOCAL), y solo un superusuario puede.
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql.raw(`truncate table ${wipe.map((t) => `public."${t}"`).join(", ")} restart identity`));
    return { tables: wipe.length };
  });
}
