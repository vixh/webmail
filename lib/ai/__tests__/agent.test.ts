/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { askAgent, AgentError, loadAgentConfig, signBody } from '../agent';

const KEY = Buffer.from('k'.repeat(32));

describe('signBody', () => {
  it('matches the agent (Python mailai.sig.sign) byte for byte', () => {
    expect(signBody(KEY, 1000, 'n1', '{"a":1}'))
      .toBe('8b71982f3dc59bdb126a9b07087808db621c4cfc7ddc34583da9040c82ddd7a8');
  });
});

describe('loadAgentConfig', () => {
  const read = (files: Record<string, string>) => (p: string) => {
    if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(files[p]);
  };

  it('is off without a URL or key file, or with a short key', () => {
    expect(loadAgentConfig({}, read({}))).toBeNull();
    expect(loadAgentConfig({ AI_AGENT_URL: 'http://10.8.0.12:8765', AI_AGENT_KEY_FILE: '/k' }, read({}))).toBeNull();
    expect(loadAgentConfig({ AI_AGENT_URL: 'http://10.8.0.12:8765', AI_AGENT_KEY_FILE: '/k' }, read({ '/k': 'short\n' })))
      .toBeNull();
  });

  it('reads the key and trims the newline', () => {
    const cfg = loadAgentConfig({ AI_AGENT_URL: 'http://10.8.0.12:8765/', AI_AGENT_KEY_FILE: '/k' },
      read({ '/k': 'k'.repeat(32) + '\n' }));
    expect(cfg?.url).toBe('http://10.8.0.12:8765');
    expect(cfg?.key.equals(KEY)).toBe(true);
  });
});

describe('askAgent', () => {
  const cfg = { url: 'http://agent', key: KEY };
  const ctx = { current: { id: 'c', text: 'Dotaz' } };

  it('sends a signed body and returns the facts', async () => {
    const fetchFn = vi.fn(async () => Response.json({ facts: { lang: 'cs' } }));
    const facts = await askAgent(cfg, ctx, { fetchFn, now: () => 1000_000, nonce: () => 'n1' });
    expect(facts).toEqual({ lang: 'cs' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://agent/v1/facts');
    expect(init.headers['X-AI-Ts']).toBe('1000');
    expect(init.headers['X-AI-Nonce']).toBe('n1');
    expect(init.headers['X-AI-Sig']).toBe(signBody(KEY, 1000, 'n1', init.body as string));
    expect(init.body).toBe(JSON.stringify({ context: ctx }));
  });

  it('turns agent failures into AgentError without the agent body', async () => {
    const fetchFn = vi.fn(async () => new Response('Traceback /home/viktor secret', { status: 500 }));
    const err = (await askAgent(cfg, ctx, { fetchFn }).catch((e) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(String(err.message)).not.toMatch(/Traceback|secret/);
  });

  it('gives up after the timeout', async () => {
    const fetchFn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const err = (await askAgent(cfg, ctx, { fetchFn: fetchFn as never, timeoutMs: 20 }).catch((e) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.timeout).toBe(true);
  });
});
