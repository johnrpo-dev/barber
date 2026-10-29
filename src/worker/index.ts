// Proceso aparte del servidor web (systemd: villa-worker).
// Usa el mismo PostgreSQL como cola: recordatorios de WhatsApp, expiración de citas pendientes.
import { PgBoss } from "pg-boss";
import { env } from "@/lib/env";

async function main() {
  const boss = new PgBoss(env().DATABASE_URL);
  boss.on("error", (err) => console.error("[worker] error de pg-boss", err));
  await boss.start();
  console.log("[worker] Villa worker arrancó");

  const stop = async () => {
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[worker] no pudo arrancar", err);
  process.exit(1);
});
