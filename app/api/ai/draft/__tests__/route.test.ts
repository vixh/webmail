/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let creds: { serverUrl: string; authHeader: string; username: string; trusted: boolean } | null;
let agentCfg: { url: string; key: Buffer } | null;
let agentResult: unknown;
const agentCalls: unknown[] = [];

vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => creds }));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: async (url: string, init: { body?: string }) => {
    if (url.endsWith('/.well-known/jmap')) {
      return Response.json({ apiUrl: 'https://mail.example.org/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A' } });
    }
    const calls = JSON.parse(init.body!).methodCalls as Array<[string, Record<string, unknown>, string]>;
    return Response.json({
      methodResponses: calls.map(([name, args, tag]) => {
        if (name === 'Email/get') {
          return [name, { list: (args.ids as string[]).filter((id) => id === 'M1').map((id) => ({
            id, threadId: 'T', mailboxIds: { i: true }, receivedAt: '2026-11-12T00:00:00Z',
            from: [{ email: 'guest@example.cz' }], to: [{ email: 'hotel@marie-luisa.cz' }], subject: 'Pokoj',
            textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { 1: { value: 'Máte volno 18.–19. 11.?' } },
          })) }, tag];
        }
        if (name === 'Thread/get') return [name, { list: [{ id: 'T', emailIds: ['M1'] }] }, tag];
        if (name === 'Email/query') return [name, { ids: [] }, tag];
        return [name, { list: [] }, tag];
      }),
    });
  },
}));
vi.mock('@/lib/ai/agent', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/agent')>()),
  loadAgentConfig: () => agentCfg,
  askAgent: async (_cfg: unknown, path: string, context: unknown) => {
    agentCalls.push({ path, context });
    if (agentResult instanceof Error) throw agentResult;
    return agentResult;
  },
}));

const { POST } = await import('../route');
const { resetAiLimits } = await import('@/lib/ai/limit');
const { AgentError } = await import('@/lib/ai/agent');

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ai/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('AI_REPLY_ENABLED', 'true');
  creds = { serverUrl: 'https://mail.example.org', authHeader: 'Basic eA==', username: 'hotel@marie-luisa.cz', trusted: true };
  agentCfg = { url: 'http://agent', key: Buffer.from('k'.repeat(32)) };
  agentResult = {
    draft: 'Dobrý den,\n\nmáme volno.\n\n[[цена: укажите сами]]', ok: true, tries: 1, attempts: [[]],
    checks: [{ code: 'todo', level: 'warn', msg: 'есть места [[…]]' }],
    plan: { status: 'available', say: ['x'], ask: [], todo: ['цена: укажите сами'] },
    facts: { lang: 'cs', req: { check_in: '2026-11-18' }, avail: { ok: true }, warn: ['w'] },
  };
  agentCalls.length = 0;
  resetAiLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/ai/draft', () => {
  it('shares the guards of the AI routes', async () => {
    vi.stubEnv('AI_REPLY_ENABLED', '');
    expect((await POST(req({ emailId: 'M1' }))).status).toBe(404);
    vi.stubEnv('AI_REPLY_ENABLED', 'true');
    expect((await POST(req({ emailId: 'M1' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    creds = null;
    expect((await POST(req({ emailId: 'M1' }))).status).toBe(401);
    expect(agentCalls).toHaveLength(0);
  });

  it('says the agent is not set up instead of failing the mail app', async () => {
    agentCfg = null;
    const res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(503);
    expect(agentCalls).toHaveLength(0);
  });

  it('sends the mail context to the agent and returns the checked draft', async () => {
    const res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      draft: 'Dobrý den,\n\nmáme volno.\n\n[[цена: укажите сами]]', ok: true,
      checks: [{ code: 'todo', level: 'warn' }], status: 'available', todo: ['цена: укажите сами'],
      lang: 'cs', warn: ['w'],
    });
    expect(body.context).toMatchObject({ guest: 'guest@example.cz', thread: 0, history: 0 });
    expect(agentCalls[0]).toMatchObject({ path: '/v1/draft', context: { current: { id: 'M1', text: 'Máte volno 18.–19. 11.?' } } });
  });

  it('never passes a malformed agent answer to the browser as a draft', async () => {
    agentResult = { draft: 42, ok: 'yes', checks: 'none' };
    const res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(502);
  });

  it('marks a draft as not ok when the agent reported a failed check', async () => {
    agentResult = { ...(agentResult as object), ok: true, checks: [{ code: 'price', level: 'fail', msg: 'цена' }] };
    const body = await (await POST(req({ emailId: 'M1' }))).json();
    expect(body.ok).toBe(false);
  });

  it('maps agent errors to 502 and timeouts to 504 without details', async () => {
    agentResult = new AgentError('agent 500');
    let res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('500');
    agentResult = new AgentError('agent timeout', true);
    res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(504);
  });
});
