import { bigint, char, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Convenciones (ver docs/arquitectura.md):
// - IDs internos bigint identity; hacia afuera solo ULID o tokens.
// - Dinero en bigint (unidades menores, mode "bigint"); nunca real/double ni number en JS.
// - Fechas en timestamptz (UTC); la zona de cada sede vive en locations.timezone.
// - Toda tabla operativa lleva location_id.

export const locations = pgTable("locations", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Bogota"),
  currency: char("currency", { length: 3 }).notNull().default("COP"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
