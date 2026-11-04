import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * SUM() de una columna bigint devuelve numeric, que los drivers entregan como texto o number.
 * Se convierte a texto en SQL y luego a bigint en JS: nunca pasa por number (ADR-001).
 */
export function sumAsBigint(column: AnyColumn | SQL): SQL<bigint> {
  return sql`coalesce(sum(${column}), 0)::text`.mapWith((value: string) => BigInt(value));
}

/** Filas de db.execute sin importar el driver (postgres.js devuelve un arreglo; PGlite, { rows }). */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}
