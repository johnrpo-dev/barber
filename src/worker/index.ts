// Proceso aparte del servidor web (systemd: villa-worker).
// Usa el mismo PostgreSQL como cola: recordatorios de WhatsApp, expiración de citas pendientes.
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db } from "@/db/client";
import type { Db } from "@/db/types";
import { env } from "@/lib/env";
import { describeError } from "@/lib/log";
import { runExpireHolds } from "./jobs/expire-holds";
import { runMaintenance } from "./jobs/maintenance";
import { runScanNotifications } from "./jobs/scan-notifications";

const TZ = "America/Bogota";

// pg-boss no admite ":" en los nombres de cola: holds:expire → holds.expire, etc.
const JOBS: { name: string; cron: string; run: (database: Db) => Promise<unknown> }[] = [
  { name: "holds.expire", cron: "* * * * *", run: (database) => runExpireHolds(database) },
  { name: "notifications.scan", cron: "* * * * *", run: (database) => runScanNotifications(database) },
  { name: "maintenance.daily", cron: "0 3 * * *", run: (database) => runMaintenance(database) },
];

/**
 * En el VPS el esquema "pgboss" lo crea src/db/roles/setup-roles.sql (dueño: villa_app) y
 * villa_app no puede crear esquemas, así que pg-boss no debe intentar CREATE SCHEMA.
 * En desarrollo, sin ese script, pg-boss lo crea como siempre.
 */
async function pgBossSchemaExists(database: Db): Promise<boolean> {
  const result: unknown = await database.execute(sql`select to_regnamespace('pgboss') is not null as present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  return rows[0]?.present === true;
}

async function main() {
  const database = db() as unknown as Db;
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, createSchema: !(await pgBossSchemaExists(database)) });
  boss.on("error", (err) => console.error("[worker] error de pg-boss", describeError(err)));
  await boss.start();

  for (const job of JOBS) {
    // "stately": a lo sumo uno en cola y uno corriendo; un barrido lento no se solapa con el siguiente.
    await boss.createQueue(job.name, { policy: "stately" });
    await boss.schedule(job.name, job.cron, null, { tz: TZ });
    await boss.work(job.name, async () => {
      try {
        const result = await job.run(database);
        // Solo conteos: nunca teléfonos, correos, códigos ni tokens.
        console.log(`[worker] ${job.name}`, JSON.stringify(result));
      } catch (err) {
        console.error(`[worker] ${job.name} falló`, describeError(err));
        throw err;
      }
    });
  }
  console.log("[worker] Villa worker arrancó");

  const stop = async () => {
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[worker] no pudo arrancar", describeError(err));
  process.exit(1);
});
