// Crea la cuenta del dueño (primer acceso a la app). La contraseña se escribe sin mostrarse
// y solo se guarda su hash. Uso: npm run staff:create-owner
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { locations } from "@/db/schema";
import { createStaffUser, StaffError } from "@/db/staff";
import type { Db } from "@/db/types";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { describeError } from "@/lib/log";

// readline escribe lo que se teclea en `output`; silenciarlo oculta la contraseña.
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: stdin, output, terminal: true });

async function askHidden(question: string): Promise<string> {
  stdout.write(question);
  muted = true;
  const answer = await rl.question("");
  muted = false;
  stdout.write("\n");
  return answer;
}

async function main() {
  const client = db();
  try {
    const [location] = await client
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .orderBy(asc(locations.id))
      .limit(1);
    if (!location) throw new StaffError("No hay sede creada. Ejecuta primero: npm run db:seed");

    console.log(`Crear dueño para la sede "${location.name}".`);
    const name = (await rl.question("Nombre: ")).trim();
    const email = (await rl.question("Correo: ")).trim();
    const password = await askHidden(`Contraseña (mínimo ${MIN_PASSWORD_LENGTH} caracteres): `);
    if (password !== (await askHidden("Repite la contraseña: "))) throw new StaffError("Las contraseñas no coinciden");

    const { staffId } = await createStaffUser(client as unknown as Db, {
      locationId: location.id,
      name,
      email,
      password,
      role: "owner",
    });
    console.log(`Listo: ${name} es dueño (personal #${staffId}). Ya puede ingresar en /ingresar.`);
  } finally {
    rl.close();
    await client.$client.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof StaffError) console.error(err.message);
  else console.error("No se pudo crear el dueño:", describeError(err));
  process.exit(1);
});
