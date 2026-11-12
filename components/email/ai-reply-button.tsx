"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, X } from "@/components/icons";
import { useConfig } from "@/hooks/use-config";
import { apiFetch } from "@/lib/browser-navigation";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { cn } from "@/lib/utils";

// "Prepare reply" for the hotel AI agent. It asks /api/ai/draft for a draft
// of the open mail and opens the normal reply editor with it - nothing is ever
// sent from here. A draft that failed the agent's checks is not put into the
// editor on its own: the person sees why and may still take it. Any failure
// stays inside this button; the mail view keeps working.

interface Check {
  code: string;
  level: "fail" | "warn";
  msg: string;
}

interface DraftAnswer {
  draft: string;
  ok: boolean;
  checks: Check[];
  warn?: string[];
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; answer: DraftAnswer; used: boolean }
  | { kind: "error"; key: string };

const ERROR_KEYS: Record<number, string> = {
  404: "err_not_found",
  429: "err_busy",
  503: "err_not_configured",
  504: "err_timeout",
};

function isAnswer(v: unknown): v is DraftAnswer {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.draft === "string" && typeof a.ok === "boolean" && Array.isArray(a.checks);
}

/** Whether the server has the AI reply on and its agent configured. */
export function useAiReplyEnabled(): boolean {
  return useConfig().aiReplyEnabled === true;
}

export function AiReplyButton({
  emailId,
  onUse,
  showLabel = true,
}: {
  emailId: string;
  onUse: (draft: string) => void;
  showLabel?: boolean;
}) {
  const t = useTranslations();
  const [state, setState] = useState<State>({ kind: "idle" });
  const busy = useRef(false);
  const current = useRef(emailId);

  useEffect(() => {
    current.current = emailId;
    busy.current = false;
    setState({ kind: "idle" });
  }, [emailId]);

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    const forId = emailId;
    setState({ kind: "loading" });
    let next: State;
    try {
      const res = await apiFetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getActiveAccountSlotHeaders() },
        body: JSON.stringify({ emailId: forId }),
      });
      const body: unknown = res.ok ? await res.json() : null;
      if (!res.ok || !isAnswer(body)) {
        next = { kind: "error", key: ERROR_KEYS[res.status] ?? "err_generic" };
      } else {
        const usable = body.ok && body.draft.trim() !== "";
        next = { kind: "done", answer: body, used: usable };
        if (current.current === forId && usable) onUse(body.draft);
      }
    } catch {
      next = { kind: "error", key: "err_generic" };
    }
    if (current.current !== forId) return;
    busy.current = false;
    setState(next);
  };

  const close = () => setState({ kind: "idle" });
  const loading = state.kind === "loading";

  const fails = state.kind === "done" ? state.answer.checks.filter((c) => c.level === "fail") : [];
  const notes = state.kind === "done"
    ? [...state.answer.checks.filter((c) => c.level === "warn").map((c) => c.msg), ...(state.answer.warn ?? [])]
    : [];
  const showPanel = state.kind === "error" || (state.kind === "done" && (fails.length > 0 || notes.length > 0 || !state.used));

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void run()}
        aria-busy={loading}
        className="flex flex-row h-8 gap-1.5 py-0"
        title={t("ai_reply.button_title")}
        aria-label={t("ai_reply.button")}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {showLabel && (
          <span className="hidden sm:inline text-sm">{loading ? t("ai_reply.loading") : t("ai_reply.button")}</span>
        )}
      </Button>

      {showPanel && (
        <div
          role="status"
          className={cn(
            "absolute end-0 top-full mt-1 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-sm shadow-lg",
            fails.length > 0 || state.kind === "error" ? "border-destructive/50" : "border-border",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">
              {state.kind === "error"
                ? t(`ai_reply.${state.key}`)
                : fails.length > 0
                  ? t("ai_reply.failed_title")
                  : t("ai_reply.warnings_title")}
            </p>
            <button
              type="button"
              onClick={close}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("ai_reply.close")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {state.kind === "done" && (
            <>
              {fails.length > 0 && (
                <ul className="mt-2 space-y-1 text-destructive">
                  {fails.map((c) => <li key={c.code}>{c.msg}</li>)}
                </ul>
              )}
              {notes.length > 0 && (
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {notes.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{t("ai_reply.todo_hint")}</p>
              {!state.used && state.answer.draft.trim() !== "" && (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onUse(state.answer.draft);
                      setState({ ...state, used: true });
                    }}
                  >
                    {t("ai_reply.use_anyway")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
