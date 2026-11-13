/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let creds: { serverUrl: string; authHeader: string; username: string; trusted: boolean } | null;
let agentCfg: { url: string; key: Buffer } | null;
let agentAnswer: unknown;
const agentCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
let sentFrom = 'hotel@marie-luisa.cz';

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
          return [name, { list: (args.ids as string[]).filter((id) => id === 'S1').map((id) => ({
            id, from: [{ email: sentFrom }], inReplyTo: ['m1@guest.cz'],
            textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { 1: { value: 'Dobrý den, pokoj je volný.' } },
          })) }, tag];
        }
        if (name === 'Identity/get') return [name, { list: [{ email: 'hotel@marie-luisa.cz' }] }, tag];
        return [name, { list: [] }, tag];
      }),
    });
  },
}));
vi.mock('@/lib/ai/agent', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/agent')>()),
  loadAgentConfig: () => agentCfg,
  askAgent: async (_cfg: unknown, path: string, payload: Record<string, unknown>) => {
    agentCalls.push({ path, payload });
    if (agentAnswer instanceof Error) throw agentAnswer;
    return agentAnswer;
  },
}));

const review = await import('../route');
const exp = await import('../../export/route');
const { resetAiLimits } = await import('@/lib/ai/limit');

function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('AI_REPLY_ENABLED', 'true');
  creds = { serverUrl: 'https://mail.example.org', authHeader: 'Basic eA==', username: 'hotel@marie-luisa.cz', trusted: true };
  agentCfg = { url: 'http://agent', key: Buffer.from('k'.repeat(32)) };
  agentCalls.length = 0;
  sentFrom = 'hotel@marie-luisa.cz';
  resetAiLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/ai/review', () => {
  it('shares the guards of the AI routes', async () => {
    expect((await review.POST(req('/api/ai/review', { emailId: 'S1' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    creds = null;
    expect((await review.POST(req('/api/ai/review', { emailId: 'S1' }))).status).toBe(401);
    expect(agentCalls).toHaveLength(0);
  });

  it('sends what really went out, for this account, to the agent', async () => {
    agentAnswer = { found: true, review_id: 7, diff: { ratio: 0.8, added: ['x'], removed: [], todo_left: [], facts: { dates: [], price: false } } };
    const res = await review.POST(req('/api/ai/review', { emailId: 'S1' }));
    expect(res.status).toBe(200);
    expect(agentCalls[0]).toEqual({
      path: '/v1/review',
      payload: { account: 'hotel@marie-luisa.cz', msgid: '<m1@guest.cz>', sent_id: 'S1', final: 'Dobrý den, pokoj je volný.' },
    });
    expect(await res.json()).toMatchObject({ found: true, reviewId: 7, diff: { ratio: 0.8 } });
  });

  it('says when there was no AI draft for that mail', async () => {
    agentAnswer = { found: false };
    expect(await (await review.POST(req('/api/ai/review', { emailId: 'S1' }))).json()).toEqual({ found: false });
  });

  it('refuses mail we did not send', async () => {
    sentFrom = 'guest@example.cz';
    expect((await review.POST(req('/api/ai/review', { emailId: 'S1' }))).status).toBe(422);
    expect(agentCalls).toHaveLength(0);
  });
});

describe('POST /api/ai/export', () => {
  it('asks the agent for the anonymized example of this account only', async () => {
    agentAnswer = { found: true, text: '## Письмо гостя\n<name> …' };
    const res = await exp.POST(req('/api/ai/export', { reviewId: 7 }));
    expect(res.status).toBe(200);
    expect(agentCalls[0]).toEqual({ path: '/v1/export', payload: { account: 'hotel@marie-luisa.cz', review_id: 7 } });
    expect(await res.json()).toEqual({ found: true, text: '## Письмо гостя\n<name> …' });
  });

  it('rejects anything but a positive integer id', async () => {
    for (const reviewId of ['7', -1, 1.5, null]) {
      expect((await exp.POST(req('/api/ai/export', { reviewId }))).status).toBe(400);
    }
    expect(agentCalls).toHaveLength(0);
  });
});
