import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { getPortal } from "../../_lib/portal";
import { linkBtn } from "../../_lib/ui";

// La misma página para todo enlace que no sirve (desconocido, vencido, revocado, de otra sede):
// no revela cuál es el caso.
export default async function CitaNotFound() {
  const portal = await getPortal();
  const whatsapp = portal?.location.whatsappUrl ?? null;
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-5 px-4 py-12">
      <h1 className="font-display text-4xl leading-tight">Este enlace ya no funciona.</h1>
      <div aria-hidden className="h-px w-16 bg-laton" />
      <p className="text-lg text-tinta/80">Puede que la cita ya pasó o el enlace venció.</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/reservar" className={linkBtn("primary", "lg")}>
          Reservar otra cita
        </Link>
        {whatsapp ? (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg")}>
            <MessageCircle size={18} aria-hidden /> Escríbenos por WhatsApp
          </a>
        ) : null}
      </div>
    </main>
  );
}
