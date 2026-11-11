"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useToast } from "./ui";

// Las rutas y acciones sin permiso redirigen con ?sin-permiso=1; aquí se avisa una vez y se
// limpia la URL para que recargar no repita el aviso.
export function NoPermissionNotice() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const denied = params.get("sin-permiso") === "1";
  // Un solo aviso por redirección, aunque el efecto corra dos veces (Strict Mode en desarrollo, o
  // un render más antes de que router.replace limpie la URL).
  const shown = useRef(false);

  useEffect(() => {
    if (!denied) {
      shown.current = false;
      return;
    }
    if (shown.current) return;
    shown.current = true;
    toast("Tu rol no tiene permiso para eso. Si lo necesitas, pídeselo al dueño.", "error");
    const rest = new URLSearchParams(params);
    rest.delete("sin-permiso");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [denied, params, pathname, router, toast]);

  return null;
}
