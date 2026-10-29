"use client";

import Script from "next/script";
import { type ReactNode, useCallback, useEffect, useRef } from "react";

// Cloudflare Turnstile en modo explícito, invisible salvo que haga falta interacción
// (appearance "interaction-only"). Solo protege startBooking (action "reservar").
// Sin site key (desarrollo, verificador falso) el token es "ok".

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Si hay que resolver un reto visible, se da tiempo de sobra antes de rendirse. */
const TIMEOUT_MS = 90_000;

export class HumanCheckError extends Error {}

export function useTurnstile(siteKey: string | null): { widget: ReactNode; getToken: () => Promise<string> } {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const pending = useRef<{ resolve: (token: string) => void; reject: (err: Error) => void } | null>(null);

  const settle = useCallback((token: string | null) => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (token) p.resolve(token);
    else p.reject(new HumanCheckError("turnstile"));
  }, []);

  const render = useCallback(() => {
    if (!siteKey || !window.turnstile || !container.current || widgetId.current) return;
    widgetId.current = window.turnstile.render(container.current, {
      sitekey: siteKey,
      action: "reservar",
      execution: "execute",
      appearance: "interaction-only",
      language: "es",
      callback: (token: string) => settle(token),
      "error-callback": () => {
        settle(null);
        return true;
      },
      "timeout-callback": () => settle(null),
      "expired-callback": () => {
        if (widgetId.current) window.turnstile?.reset(widgetId.current);
      },
    });
  }, [siteKey, settle]);

  useEffect(
    () => () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
      settle(null);
    },
    [settle],
  );

  const getToken = useCallback(async () => {
    if (!siteKey) return "ok";
    const api = window.turnstile;
    const id = widgetId.current;
    if (!api || !id) throw new HumanCheckError("turnstile-not-ready");
    return new Promise<string>((resolve, reject) => {
      pending.current = { resolve, reject };
      // Cada token sirve una sola vez: se reinicia antes de pedir otro.
      api.reset(id);
      api.execute(id);
      setTimeout(() => {
        if (pending.current?.resolve === resolve) settle(null);
      }, TIMEOUT_MS);
    });
  }, [siteKey, settle]);

  const widget = siteKey ? (
    <>
      <Script src={SRC} strategy="afterInteractive" onReady={render} />
      <div ref={container} className="empty:hidden" />
    </>
  ) : null;

  return { widget, getToken };
}
