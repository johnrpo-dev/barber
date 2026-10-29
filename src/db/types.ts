import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/** Cliente Drizzle o transacción, sin importar el driver (postgres.js en la app, PGlite en tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
