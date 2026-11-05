// Utilidades de clases SIN "use client": sirven igual en componentes de servidor y de cliente.
// Un componente de servidor no puede llamar funciones ni leer constantes de un módulo
// "use client" (le llegan como referencias de cliente); por eso viven aquí y no en ui.tsx ni en
// controls.tsx, que las reexportan. La guarda está en src/app/client-boundary.test.ts.

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Tarjeta del panel. */
export const card = "rounded-xl border border-tinta/10 bg-papel";
