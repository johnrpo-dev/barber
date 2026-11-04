"use client";

import { ArrowLeft, Printer, Share2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Btn, useToast } from "../../_components/ui";

// Botones del comprobante: imprimir (la hoja de impresión oculta la navegación y estos botones) y
// compartir el enlace. Abrir el enlace exige sesión y permiso: no expone nada a quien no lo tenga.

export function ReceiptToolbar({ title }: { title: string }) {
  const router = useRouter();
  const toast = useToast();

  async function share() {
    const url = window.location.href;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast("Enlace copiado. Para abrirlo hay que entrar a Villa.");
    } catch (err) {
      // Cerrar el menú de compartir no es un error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast("No se pudo compartir. Copia la dirección de la página.", "error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <Btn variant="ghost" onPress={() => (window.history.length > 1 ? router.back() : router.push("/panel"))}>
        <ArrowLeft size={18} aria-hidden /> Volver
      </Btn>
      <div className="ml-auto flex gap-2">
        <Btn variant="secondary" onPress={() => void share()}>
          <Share2 size={18} aria-hidden /> Compartir
        </Btn>
        <Btn onPress={() => window.print()}>
          <Printer size={18} aria-hidden /> Imprimir
        </Btn>
      </div>
    </div>
  );
}
