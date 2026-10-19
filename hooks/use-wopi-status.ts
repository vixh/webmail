"use client";

import { useEffect, useState } from "react";
import { IS_LITE } from "@/lib/lite";
import { apiFetch } from "@/lib/browser-navigation";

/**
 * Whether a WOPI document editor is configured for this deployment and which
 * file extensions it handles (#425). Fetched once per page load and shared
 * across consumers via a module-level promise.
 */
export interface WopiStatus {
  enabled: boolean;
  editExtensions: string[];
  viewExtensions: string[];
}

const DISABLED: WopiStatus = { enabled: false, editExtensions: [], viewExtensions: [] };

// Mail can mount before the cookie-backed session bootstrap has finished. A
// 401 then means "not ready yet", not "WOPI is disabled". Caching it would
// hide Office preview buttons until the page is reloaded.
class WopiAuthPendingError extends Error {}

let statusPromise: Promise<WopiStatus> | null = null;

function fetchWopiStatus(): Promise<WopiStatus> {
  // The WOPI bridge is a server feature; the static build never has an editor.
  if (IS_LITE) return Promise.resolve(DISABLED);
  if (!statusPromise) {
    statusPromise = apiFetch("/api/wopi/status")
      .then((res) => {
        if (res.status === 401) throw new WopiAuthPendingError();
        return res.ok ? res.json() : DISABLED;
      })
      .then((data) => ({
        enabled: !!data?.enabled,
        editExtensions: Array.isArray(data?.editExtensions) ? data.editExtensions : [],
        viewExtensions: Array.isArray(data?.viewExtensions) ? data.viewExtensions : [],
      }))
      .catch((error) => {
        statusPromise = null;
        throw error;
      });
  }
  return statusPromise;
}

export function useWopiStatus(enabled: boolean): WopiStatus | null {
  const [status, setStatus] = useState<WopiStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      fetchWopiStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof WopiAuthPendingError) {
            retryTimer = setTimeout(load, 1000);
          } else {
            setStatus(DISABLED);
          }
        });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled]);

  return status;
}

/** Lowercased extension of a file name, without the dot. */
export function fileExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
}

/** Whether the configured editor can open (edit or view) a file of this name. */
export function canWopiOpen(status: WopiStatus | null, name?: string | null): boolean {
  if (!status?.enabled || !name) return false;
  const ext = fileExtension(name);
  return !!ext && (status.editExtensions.includes(ext) || status.viewExtensions.includes(ext));
}
