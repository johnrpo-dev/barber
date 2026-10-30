// Desbloquea la cuenta de alguien del personal: borra sus contadores de intentos (ingreso desde
// cualquier IP, límite global del correo, reautenticación y contraseña) y el bloqueo del código de
// la app. Para el dueño que quedó fuera por un ataque o por equivocarse muchas veces.
// Uso: npm run staff:unlock -- correo@ejemplo.com
// No imprime nada sensible: ni el correo, ni sujetos, ni secretos.
import { db } from "@/db/client";
import { unlockAccount } from "@/db/login-throttle";
import type { Db } from "@/db/types";
import { describeError } from "@/lib/log";

async function main() {
  const email = (process.argv[2] ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    console.error("Uso: npm run staff:unlock -- correo@ejemplo.com");
    process.exit(2);
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    console.error("Falta BETTER_AUTH_SECRET (el mismo de la app): sin él no se pueden ubicar los bloqueos.");
    process.exit(2);
  }
  const client = db();
  try {
    const cleared = await unlockAccount(client as unknown as Db, { secret, email });
    console.log(cleared === 0 ? "No había bloqueos ni intentos fallidos para esa cuenta." : `Listo: se borraron ${cleared} registros de bloqueo.`);
  } finally {
    await client.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error("No se pudo desbloquear:", describeError(err));
  process.exit(1);
});
