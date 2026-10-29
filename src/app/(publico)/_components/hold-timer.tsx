"use client";

import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../_lib/ui";

// Cuenta regresiva de la retención. Manda el expires_at del servidor. El reloj no se anuncia
// cada segundo (role=timer, aria-live=off); un status oculto avisa solo a los 5, 2 y 1 minutos.

const MARKS = [5, 2, 1] as const;

function bucket(ms: number): number | null {
  // El menor aviso ya alcanzado: con 4:59 → 5; con 1:30 → 2; con 0:40 → 1.
  let hit: number | null = null;
  for (const m of MARKS) if (ms <= m * 60_000) hit = m;
  return hit;
}

export function HoldTimer({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const end = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const lastMark = useRef<number | null>(bucket(end - Date.now()));
  const expired = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, end - now);

  useEffect(() => {
    const mark = bucket(remaining);
    if (mark !== null && mark !== lastMark.current && remaining > 0) {
      lastMark.current = mark;
      setAnnouncement(mark === 1 ? "Te queda 1 minuto para confirmar tu horario." : `Te quedan ${mark} minutos para confirmar tu horario.`);
    }
    if (remaining === 0 && !expired.current) {
      expired.current = true;
      onExpire();
    }
  }, [remaining, onExpire]);

  const totalSec = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  const urgent = remaining < 2 * 60_000;

  return (
    <div
      className={cx(
        "sticky top-0 z-10 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-hueso shadow-sm transition-colors",
        urgent ? "bg-alerta" : "bg-botella",
      )}
    >
      <Clock size={16} aria-hidden className="shrink-0" />
      <p>
        Te guardamos el horario{" "}
        <strong role="timer" aria-live="off" className="monto text-base">
          {clock}
        </strong>
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
