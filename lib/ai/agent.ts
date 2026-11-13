import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Client for the hotel AI agent (mailai) on the model server. Every request is
// signed with HMAC-SHA256 over "ts.nonce.body"; the agent rejects unsigned,
// stale or replayed requests. The key lives in a file outside the app
// (AI_AGENT_KEY_FILE); without it the AI features are simply off.

export interface AgentConfig {
  url: string;
  key: Buffer;
}

export class AgentError extends Error {
  constructor(message: string, readonly timeout = false) {
    super(message);
    this.name = 'AgentError';
  }
}

const MIN_KEY = 32;
const TIMEOUT_MS = 150_000;

export function signBody(key: Buffer, ts: number, nonce: string, body: string): string {
  return createHmac('sha256', key).update(`${ts}.${nonce}.${body}`).digest('hex');
}

export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): AgentConfig | null {
  const url = env.AI_AGENT_URL?.trim().replace(/\/+$/, '');
  const keyFile = env.AI_AGENT_KEY_FILE?.trim();
  if (!url || !keyFile) return null;
  let key: Buffer;
  try {
    key = Buffer.from(read(keyFile).toString('utf8').trim());
  } catch {
    return null;
  }
  return key.length >= MIN_KEY ? { url, key } : null;
}

export async function askAgent(
  cfg: AgentConfig,
  path: '/v1/facts' | '/v1/draft' | '/v1/review' | '/v1/export',
  payload: Record<string, unknown>,
  opts: {
    fetchFn?: typeof fetch;
    now?: () => number;
    nonce?: () => string;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const ts = Math.floor((opts.now ?? Date.now)() / 1000);
  const nonce = (opts.nonce ?? (() => randomBytes(16).toString('hex')))();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await (opts.fetchFn ?? fetch)(`${cfg.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Ts': String(ts),
        'X-AI-Nonce': nonce,
        'X-AI-Sig': signBody(cfg.key, ts, nonce, body),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new AgentError(`agent ${res.status}`);
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AgentError('agent: bad answer');
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new AgentError(aborted ? 'agent timeout' : 'agent unreachable', aborted);
  } finally {
    clearTimeout(timer);
  }
}
