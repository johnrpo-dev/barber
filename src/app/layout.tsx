import type { Metadata, Viewport } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";
import { BUSINESS_NAME } from "@/domain/brand";

// Títulos en Newsreader (sprint 6): J recta sobre la línea, F limpia y cifras tabulares de serie,
// así `.monto` alinea también en los títulos. Reemplazó a Fraunces, cuya J con gancho y F con
// picos no gustaron. Sin ejes extra: el tamaño óptico fijo pesa menos (~57 KB) y se ve bien.
const display = Newsreader({ subsets: ["latin"], variable: "--font-display-face" });
const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-public-sans" });

export const metadata: Metadata = {
  title: BUSINESS_NAME,
  description: `Reserva tu cita en ${BUSINESS_NAME}.`,
};

export const viewport: Viewport = {
  themeColor: "#f4efe6",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Todo se renderiza por petición: una página estática (la 404) sale sin el nonce de src/proxy.ts
  // y la CSP frenaría sus scripts. Las demás rutas ya eran dinámicas.
  await connection();
  return (
    <html lang="es-CO" className={`${display.variable} ${publicSans.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
