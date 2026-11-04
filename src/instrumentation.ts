import { cspEnforced } from "@/lib/csp";

// Al arrancar el servidor: si producción corre sin bloquear scripts, que quede dicho en el registro.
// Es válido durante la semana de prueba o una vuelta atrás, pero no debe quedarse así por olvido.
export function register(): void {
  if (process.env.NODE_ENV === "production" && !cspEnforced()) {
    console.warn("[csp] AVISO: CSP_ENFORCE=false; la política solo reporta y no bloquea scripts (docs/despliegue.md)");
  }
}
