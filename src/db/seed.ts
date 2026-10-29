// Crea la sede de Villa con su plan de cuentas. Se puede ejecutar varias veces: no duplica.
// Uso: npm run db:seed
import { eq } from "drizzle-orm";
import { db } from "./client";
import { createLocation } from "./ledger";
import { locations } from "./schema";
import type { Db } from "./types";

const VILLA = { name: "Villa Barbería", timezone: "America/Bogota", currency: "COP" } as const;

async function main() {
  const client = db();
  const [existing] = await client.select({ id: locations.id }).from(locations).where(eq(locations.name, VILLA.name));
  if (existing) {
    console.log(`La sede "${VILLA.name}" ya existe (id ${existing.id}). Nada que hacer.`);
  } else {
    const id = await createLocation(client as unknown as Db, VILLA);
    console.log(`Sede "${VILLA.name}" creada (id ${id}) con su plan de cuentas.`);
  }
  await client.$client.end();
}

main().catch((err) => {
  console.error("No se pudo sembrar la base:", err);
  process.exit(1);
});
