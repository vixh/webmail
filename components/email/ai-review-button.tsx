"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Check, Copy, Loader2, Search, X } from "@/components/icons";
import { apiFetch } from "@/lib/browser-navigation";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { cn } from "@/lib/utils";

// "Review reply" on a reply we sent: compares what went out with the AI draft
// it started from (/api/ai/review). The agent keeps the pair as an example for
// similar mail. An anonymized write-up for an outside assistant is shown only
// after the person confirms, and only to copy: nothing is sent from here.

interface Diff {
  ratio: number;
  added: string[];
  removed: string[];
  todo_left: string[];
  facts?: { dates?: string[]; price?: boolean };
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "done"; reviewId: number; diff: Diff; step: "summary" | "confirm" | "exporting" | "export"; text?: string }
  | { kind: "error"; key: string };

const ERROR_KEYS: Record<number, string> = {
  404: "err_not_found",
  422: "err_not_reply",
  429: "err_busy",
  503: "err_not_configured",
  504: "err_timeout",
};
const SHOW = 5;

async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getActiveAccountSlotHeaders() },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: res.ok ? await res.json() : null };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function AiReviewButton({ emailId, showLabel = true }: { emailId: string; showLabel?: boolean }) {
  const t = useTranslations();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const current = useRef(emailId);

  useEffect(() => {
    current.current = emailId;
    setState({ kind: "idle" });
  }, [emailId]);

  const run = async () => {
    if (state.kind === "loading") return;
    const forId = emailId;
    setState({ kind: "loading" });
    let next: State;
    try {
      const { status, data } = await post("/api/ai/review", { emailId: forId });
      const d = data as { found?: unknown; reviewId?: unknown; diff?: Record<string, unknown> } | null;
      if (status !== 200 || !d) next = { kind: "error", key: ERROR_KEYS[status] ?? "err_generic" };
      else if (d.found !== true || typeof d.reviewId !== "number" || !d.diff) next = { kind: "none" };
      else {
        next = {
          kind: "done", reviewId: d.reviewId, step: "summary",
          diff: {
            ratio: typeof d.diff.ratio === "number" ? d.diff.ratio : 0,
            added: strings(d.diff.added), removed: strings(d.diff.removed), todo_left: strings(d.diff.todo_left),
            facts: d.diff.facts as Diff["facts"],
          },
        };
      }
    } catch {
      next = { kind: "error", key: "err_generic" };
    }
    if (current.current === forId) setState(next);
  };

  const exportIt = async (s: Extract<State, { kind: "done" }>) => {
    setState({ ...s, step: "exporting" });
    try {
      const { status, data } = await post("/api/ai/export", { reviewId: s.reviewId });
      const d = data as { found?: unknown; text?: unknown } | null;
      if (status === 200 && d?.found === true && typeof d.text === "string") {
        setState({ ...s, step: "export", text: d.text });
        return;
      }
      setState({ kind: "error", key: ERROR_KEYS[status] ?? "err_generic" });
    } catch {
      setState({ kind: "error", key: "err_generic" });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Copy can be blocked; the text stays selectable in the box.
    }
  };

  const loading = state.kind === "loading";
  const open = state.kind !== "idle" && state.kind !== "loading";

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void run()}
        aria-busy={loading}
        className="flex flex-row h-8 gap-1.5 py-0"
        title={t("ai_review.button_title")}
        aria-label={t("ai_review.button")}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        {showLabel && <span className="hidden sm:inline text-sm">{t("ai_review.button")}</span>}
      </Button>

      {open && (
        <div
          role="status"
          className={cn(
            "absolute end-0 top-full mt-1 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-sm shadow-lg",
            state.kind === "error" || (state.kind === "done" && state.diff.todo_left.length) ? "border-destructive/50" : "border-border",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">
              {state.kind === "error" ? t(`ai_review.${state.key}`)
                : state.kind === "none" ? t("ai_review.no_draft")
                  : t("ai_review.title")}
            </p>
            <button
              type="button"
              onClick={() => setState({ kind: "idle" })}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("ai_review.close")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {state.kind === "done" && state.step !== "export" && (
            <div className="mt-2 space-y-2">
              <p className="text-muted-foreground">{t("ai_review.match")}: {Math.round(state.diff.ratio * 100)}%</p>
              {state.diff.todo_left.length > 0 && (
                <div className="text-destructive">
                  <p>{t("ai_review.todo_left")}</p>
                  <ul className="list-disc ps-5">{state.diff.todo_left.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}
              {state.diff.added.length > 0 && (
                <div>
                  <p className="font-medium">{t("ai_review.added")}</p>
                  <ul className="list-disc ps-5 text-muted-foreground">
                    {state.diff.added.slice(0, SHOW).map((x, i) => <li key={i}>{x}</li>)}
                  </ul>
                </div>
              )}
              {state.diff.removed.length > 0 && (
                <div>
                  <p className="font-medium">{t("ai_review.removed")}</p>
                  <ul className="list-disc ps-5 text-muted-foreground">
                    {state.diff.removed.slice(0, SHOW).map((x, i) => <li key={i}>{x}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("ai_review.saved")}</p>
              {state.step === "confirm" ? (
                <div className="rounded-md border border-border p-2">
                  <p>{t("ai_review.export_warning")}</p>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setState({ ...state, step: "summary" })}>
                      {t("ai_review.cancel")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void exportIt(state)}>
                      {t("ai_review.export_confirm")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={state.step === "exporting"}
                    onClick={() => setState({ ...state, step: "confirm" })}
                  >
                    {state.step === "exporting" && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
                    {t("ai_review.export")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {state.kind === "done" && state.step === "export" && state.text !== undefined && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">{t("ai_review.export_hint")}</p>
              <textarea
                readOnly
                value={state.text}
                rows={10}
                className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
              />
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void copy(state.text ?? "")}>
                  {copied ? <Check className="w-4 h-4 me-1" /> : <Copy className="w-4 h-4 me-1" />}
                  {t("ai_review.copy")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
