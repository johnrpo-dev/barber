"use client";

import type { Ref } from "react";

// Resumen de errores de un envío: role=alert, recibe el foco y enlaza a cada campo (el campo
// además muestra su propio mensaje). `name` es el atributo name del control a enfocar.

export type SummaryItem = { message: string; name?: string };

export function ErrorSummary({
  title = "Revisa esto antes de seguir:",
  items,
  ref,
}: {
  title?: string;
  items: SummaryItem[];
  ref?: Ref<HTMLDivElement>;
}) {
  if (items.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-alerta/30 bg-alerta/5 p-4 text-sm text-alerta outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-alerta"
    >
      <p className="font-semibold">{title}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {items.map((item) => (
          <li key={`${item.name ?? ""}:${item.message}`}>
            {item.name ? (
              <a
                href={`#campo-${item.name}`}
                className="font-medium underline underline-offset-4"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector<HTMLElement>(`[name="${item.name}"]`)?.focus();
                }}
              >
                {item.message}
              </a>
            ) : (
              <span className="font-medium">{item.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
