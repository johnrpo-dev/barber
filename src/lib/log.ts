// Errores para el registro sin datos sensibles. Drizzle incluye en el mensaje los parámetros
// de la consulta (correos, celulares, hashes de contraseña): se corta antes de "params:".

/** Lo mínimo para diagnosticar: nombre, código y constraint de Postgres, y el mensaje sin parámetros. */
export function describeError(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const { name, message, code, constraint_name, constraint } = e as Record<string, unknown>;
    out[`level${depth}`] = {
      name,
      code,
      constraint: constraint_name ?? constraint,
      message: typeof message === "string" ? message.split(/\nparams:|params:/)[0]?.slice(0, 300) : undefined,
    };
  }
  return out;
}
