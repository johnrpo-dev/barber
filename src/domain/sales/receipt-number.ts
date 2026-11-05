/** Número corto de una venta en recibos, listas y exportaciones: los últimos 8 caracteres del ULID. */
export const saleNumber = (publicId: string): string => publicId.slice(-8);
