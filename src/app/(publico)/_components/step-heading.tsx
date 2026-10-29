import type { ReactNode, Ref } from "react";

// Título de cada paso. tabIndex=-1: el flujo le pasa el foco al cambiar de paso, así el lector
// de pantalla lee dónde está y el teclado sigue desde ahí. No es un control: sin anillo de foco.

export function StepHeading({ children, hint, ref }: { children: ReactNode; hint?: ReactNode; ref?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 ref={ref} tabIndex={-1} className="font-display text-3xl leading-tight outline-none">
        {children}
      </h2>
      {hint ? <p className="text-sm text-tinta/70">{hint}</p> : null}
    </div>
  );
}
