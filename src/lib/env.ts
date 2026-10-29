import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  APP_TIMEZONE: z.string().default("America/Bogota"),
  APP_CURRENCY: z.literal("COP").default("COP"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Variables de entorno validadas. Falla al arrancar si falta algo, no a mitad de un cobro. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
