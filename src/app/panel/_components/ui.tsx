"use client";

import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, type ButtonProps, Dialog, Heading, I18nProvider, Modal, ModalOverlay } from "react-aria-components";

// Piezas compartidas del panel. Todo lo interactivo es de react-aria-components (teclado,
// lector de pantalla y táctil resueltos); aquí solo se les da la piel "Navaja y Cuero".

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ─── Botones ─────────────────────────────────────────────────────────────────

const VARIANTS = {
  primary: "bg-cuero text-hueso hover:bg-cuero/90",
  success: "bg-botella text-hueso hover:bg-botella/90",
  secondary: "border border-tinta/20 bg-papel text-tinta hover:border-tinta/40",
  ghost: "text-tinta hover:bg-tinta/5",
  danger: "border border-alerta/30 bg-papel text-alerta hover:bg-alerta/5",
  /** Sobre fondo oscuro (tinta): texto y anillo de foco claros. */
  onDark: "text-hueso hover:bg-hueso/10 data-[focus-visible]:outline-hueso!",
} as const;

const SIZES = { sm: "h-9 px-3 text-sm", md: "h-11 px-4 text-sm", lg: "h-12 px-5 text-base", xl: "h-14 px-6 text-lg" } as const;

export function Btn({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; className?: string }) {
  return (
    <Button
      {...props}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold transition-[transform,background-color,border-color,opacity] duration-150 ease-[var(--ease-villa)]",
        "data-[pressed]:scale-[.98] data-[disabled]:opacity-50 data-[pending]:opacity-70",
        "outline-none data-[focus-visible]:outline-3 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-cuero",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    />
  );
}

// ─── Campos ──────────────────────────────────────────────────────────────────

export const field = {
  root: "flex flex-col gap-1.5",
  label: "text-sm font-semibold text-tinta",
  input:
    "h-12 w-full rounded-lg border border-tinta/50 bg-papel px-3 text-base text-tinta transition-colors placeholder:text-tinta/60 focus:border-cuero data-[focused]:border-cuero data-[invalid]:border-alerta",
  description: "text-xs text-tinta/70",
  error: "text-sm font-medium text-alerta",
};

// ─── Hoja / modal ────────────────────────────────────────────────────────────

/**
 * En celular es una hoja que sube desde abajo; en pantallas anchas, un modal centrado
 * (o un panel lateral con `drawer`, que deja ver la agenda detrás).
 */
export function Sheet({
  isOpen,
  onOpenChange,
  title,
  description,
  children,
  drawer = false,
  wide = false,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  drawer?: boolean;
  wide?: boolean;
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className={cx(
        "fixed inset-0 z-50 flex items-end bg-tinta/30 data-[entering]:animate-fade-in data-[exiting]:animate-fade-out",
        drawer ? "lg:items-stretch lg:justify-end lg:bg-tinta/10" : "md:items-center md:justify-center md:p-6",
      )}
    >
      <Modal
        className={cx(
          "max-h-[92dvh] w-full overflow-hidden rounded-t-2xl bg-papel shadow-2xl outline-none",
          "data-[entering]:animate-sheet-in data-[exiting]:animate-sheet-out",
          drawer
            ? "lg:h-dvh lg:max-h-none lg:w-[420px] lg:rounded-none lg:data-[entering]:animate-drawer-in lg:data-[exiting]:animate-drawer-out"
            : cx("md:rounded-2xl md:data-[entering]:animate-pop-in", wide ? "md:max-w-2xl" : "md:max-w-lg"),
        )}
      >
        <Dialog className="flex max-h-[92dvh] flex-col outline-none lg:max-h-dvh">
          {({ close }) => (
            <>
              <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-tinta/15 md:hidden" aria-hidden />
              <header className="flex shrink-0 items-start justify-between gap-3 border-b border-tinta/10 px-5 pb-3 pt-3 md:pt-5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Heading slot="title" className="font-display text-2xl leading-tight">
                    {title}
                  </Heading>
                  {description ? <p className="text-sm text-tinta/70">{description}</p> : null}
                </div>
                <Btn variant="ghost" size="sm" aria-label="Cerrar" onPress={close} className="-mr-2 h-11 w-11 px-0">
                  <X size={20} strokeWidth={1.75} aria-hidden />
                </Btn>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {children}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// ─── Avisos (toasts) ─────────────────────────────────────────────────────────

type Toast = { id: number; message: string; tone: "success" | "error" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

/** Tiempo visible de un aviso de éxito; se detiene mientras el puntero o el foco están encima. */
const TOAST_MS = 7000;

/**
 * Avisos breves. Las dos regiones vivas están siempre montadas (los lectores de pantalla solo
 * anuncian cambios en regiones que ya existían); los avisos visibles no son regiones vivas, para
 * no anunciarse dos veces. Los errores se quedan hasta cerrarlos.
 * También fija el idioma de los componentes (calendarios, fechas) en español de Colombia.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announced, setAnnounced] = useState<{ status: string; alert: string }>({ status: "", alert: "" });
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = ++next.current;
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    // Un mensaje repetido debe volver a anunciarse: se marca con un espacio no separable alterno.
    const text = id % 2 ? message : `${message}\u00a0`;
    setAnnounced((a) => (tone === "error" ? { ...a, alert: text } : { ...a, status: text }));
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      <I18nProvider locale="es-CO">{children}</I18nProvider>
      <div role="status" className="sr-only">
        {announced.status}
      </div>
      <div role="alert" className="sr-only">
        {announced.alert}
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(TOAST_MS);
  useEffect(() => {
    if (toast.tone !== "success" || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [toast, paused, onDismiss]);
  return (
    <div
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cx(
        "pointer-events-auto flex w-full max-w-md animate-pop-in items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-lg",
        toast.tone === "error" ? "bg-alerta text-hueso" : "bg-tinta text-hueso",
      )}
    >
      <span>{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-hueso/10"
        aria-label="Cerrar aviso"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

// ─── Encabezado de página ────────────────────────────────────────────────────

export function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        {eyebrow ? <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">{eyebrow}</p> : null}
        <h1 className="font-display text-3xl leading-tight">{title}</h1>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export { cx };
