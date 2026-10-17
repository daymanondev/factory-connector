/**
 * The `Fleet surface`'s poll clock — the reference surface's usePoll trimmed
 * to the Fleet pulse cadence: 5s while the surface is open (the component is
 * mounted), 60s when it goes quiet. Keeps the last good view on errors and
 * restarts when the reload key changes. No `document` reference survives on
 * Hermes (the typeof guard), no node built-ins.
 */
import { useEffect, useRef, useState } from "react";

/** `Fleet pulse` cadence while the `Fleet surface` is open (ADR 0001 §3: 5–10s). */
export const FLEET_ACTIVE_MS = 5000;

/** Fallback quiet cadence — matches the server's idle gate. */
export const FLEET_QUIET_MS = 60000;

export type Failed = { code: string; message: string };
export type Loaded<T> = { value: T | null; error: Failed | null; at: number | null };

/** The `document` visibility page, when a DOM host provides one — undefined on Hermes. */
const page = typeof document === "undefined" ? undefined : (document as { visibilityState?: string; addEventListener?: (n: string, f: () => void) => void; removeEventListener?: (n: string, f: () => void) => void } | undefined);

function hidden(): boolean {
  return page?.visibilityState === "hidden";
}

export function usePoll<T>(
  load: () => Promise<{ ok: true; value: T } | { ok: false; code: string; error: string }>,
  reloadKey: string,
  every: (value: T | null) => number,
): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ value: null, error: null, at: null });
  const latest = useRef({ load, every });
  latest.current = { load, every };
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: T | null = null;
    const again = () => {
      if (live) timer = setTimeout(tick, hidden() ? FLEET_QUIET_MS : latest.current.every(last));
    };
    const tick = async () => {
      if (hidden()) return again();
      try {
        const r = await latest.current.load();
        if (r.ok) last = r.value;
        if (live) setState((s) => (r.ok ? { value: r.value, error: null, at: Date.now() } : { ...s, error: { code: r.code, message: r.error } }));
      } catch (error) {
        if (live) setState((s) => ({ ...s, error: { code: "failed", message: String(error) } }));
      }
      again();
    };
    const shown = () => {
      if (hidden() || !live) return;
      clearTimeout(timer);
      void tick();
    };
    setState({ value: null, error: null, at: null });
    void tick();
    page?.addEventListener?.("visibilitychange", shown);
    return () => {
      live = false;
      clearTimeout(timer);
      page?.removeEventListener?.("visibilitychange", shown);
    };
  }, [reloadKey]);
  return state;
}
