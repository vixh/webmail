// In-memory request budget for the AI routes. Keyed by the signed-in JMAP
// username (it comes from the encrypted session cookie, not from anything the
// client can set), plus one ceiling across all users so a burst cannot tie up
// the model server.

const WINDOW_MS = 60_000;
const PER_USER = 20;
const GLOBAL = 120;

interface Window { count: number; resetAt: number }

const users = new Map<string, Window>();
let all: Window = { count: 0, resetAt: 0 };

function bump(w: Window | undefined, now: number): Window {
  return !w || w.resetAt <= now ? { count: 0, resetAt: now + WINDOW_MS } : w;
}

export function checkAiLimit(user: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  all = bump(all, now);
  const mine = bump(users.get(user), now);
  users.set(user, mine);
  if (all.count >= GLOBAL) return { allowed: false, retryAfterMs: all.resetAt - now };
  if (mine.count >= PER_USER) return { allowed: false, retryAfterMs: mine.resetAt - now };
  all.count++;
  mine.count++;
  if (users.size > 1000) {
    for (const [key, w] of users) if (w.resetAt <= now) users.delete(key);
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function resetAiLimits(): void {
  users.clear();
  all = { count: 0, resetAt: 0 };
}
