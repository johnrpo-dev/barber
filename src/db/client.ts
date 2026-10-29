import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

let instance: ReturnType<typeof create> | undefined;

function create() {
  // bigint de Postgres → bigint de JS: nunca a number, para no perder precisión en montos.
  const sql = postgres(env().DATABASE_URL, { types: { bigint: postgres.BigInt } });
  return drizzle(sql, { schema });
}

export function db() {
  instance ??= create();
  return instance;
}
