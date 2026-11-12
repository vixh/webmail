/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let creds: { serverUrl: string; authHeader: string; username: string; trusted: boolean } | null;
let jmapFails = false;
const jmapBodies: string[] = [];

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => creds,
}));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    if (jmapFails) throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-path');
    if (url.endsWith('/.well-known/jmap')) {
      return Response.json({ apiUrl: 'https://mail.example.org/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A' } });
    }
    jmapBodies.push(init.body!);
    const calls = JSON.parse(init.body!).methodCalls as Array<[string, Record<string, unknown>, string]>;
    return Response.json({
      methodResponses: calls.map(([name, args, tag]) => {
        if (name === 'Email/get') {
          return [name, { list: (args.ids as string[]).filter((id) => id === 'M1').map((id) => ({
            id, threadId: 'T', mailboxIds: { i: true }, keywords: {}, receivedAt: '2026-11-10T00:00:00Z',
            from: [{ email: 'guest@example.cz' }], to: [{ email: 'info@marieluisa.cz' }], subject: 'Pokoj',
            textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { 1: { value: 'Máte volno?' } },
          })) }, tag];
        }
        if (name === 'Thread/get') return [name, { list: [{ id: 'T', emailIds: ['M1'] }] }, tag];
        if (name === 'Email/query') return [name, { ids: [] }, tag];
        return [name, { list: [] }, tag];
      }),
    });
  },
}));

const { POST } = await import('../route');
const { resetAiLimits } = await import('@/lib/ai/limit');

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ai/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('AI_REPLY_ENABLED', 'true');
  creds = { serverUrl: 'https://mail.example.org', authHeader: 'Basic eA==', username: 'info@marieluisa.cz', trusted: true };
  jmapFails = false;
  jmapBodies.length = 0;
  resetAiLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/ai/context — guards', () => {
  it('does not exist while the feature is off', async () => {
    vi.stubEnv('AI_REPLY_ENABLED', '');
    expect((await POST(req({ emailId: 'M1' }))).status).toBe(404);
  });

  it('rejects a cross-site request', async () => {
    expect((await POST(req({ emailId: 'M1' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
  });

  it('requires a signed-in Bulwark session', async () => {
    creds = null;
    expect((await POST(req({ emailId: 'M1' }))).status).toBe(401);
  });

  it('rejects ids that are not JMAP ids and oversized bodies', async () => {
    for (const emailId of ['', '../x', 'a b', 'x'.repeat(300), 42, null]) {
      expect((await POST(req({ emailId }))).status).toBe(400);
    }
    expect((await POST(req('{nope'))).status).toBe(400);
    expect((await POST(req({ emailId: 'M1', pad: 'x'.repeat(20_000) }))).status).toBe(413);
    expect(jmapBodies).toHaveLength(0);
  });

  it('limits how often one user can ask', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await POST(req({ emailId: 'M1' }))).status;
    expect(last).toBe(429);
    creds = { ...creds!, username: 'recepce@marieluisa.cz' };
    expect((await POST(req({ emailId: 'M1' }))).status).toBe(200);
  });

  it('hides upstream error details', async () => {
    jmapFails = true;
    const res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/ECONNREFUSED|secret|10\.0\.0\.1/);
  });
});

describe('POST /api/ai/context — result', () => {
  it('returns 404 for a mail this account cannot read', async () => {
    expect((await POST(req({ emailId: 'OTHER' }))).status).toBe(404);
  });

  it('returns the selected context of the mail', async () => {
    const res = await POST(req({ emailId: 'M1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const body = await res.json();
    expect(body.context.current).toMatchObject({ id: 'M1', text: 'Máte volno?', direction: 'in' });
    expect(body.context.guest).toBe('guest@example.cz');
    expect(JSON.stringify(body)).not.toContain('Basic');
  });
});
