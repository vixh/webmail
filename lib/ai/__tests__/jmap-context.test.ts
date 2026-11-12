import { describe, expect, it } from 'vitest';
import { loadMailContext, MailNotFoundError, type JmapCall } from '../jmap-context';

type Call = [string, Record<string, unknown>, string];

const base = { threadId: 't1', keywords: {}, size: 1, hasAttachment: false, preview: '', blobId: 'b',
  textBody: [{ partId: '1', type: 'text/plain' }] };
const emails: Record<string, Record<string, unknown>> = {
  cur: { ...base, id: 'cur', mailboxIds: { inbox: true }, from: [{ email: 'jana@example.cz' }],
    to: [{ email: 'info@marieluisa.cz' }], receivedAt: '2026-11-10T00:00:00Z', bodyValues: { 1: { value: 'Dotaz' } } },
  r1: { ...base, id: 'r1', mailboxIds: { sent: true }, from: [{ email: 'info@marieluisa.cz' }],
    to: [{ email: 'jana@example.cz' }], receivedAt: '2026-11-05T00:00:00Z', bodyValues: { 1: { value: 'Odpověď' } } },
  d1: { ...base, id: 'd1', mailboxIds: { drafts: true }, from: [{ email: 'info@marieluisa.cz' }],
    receivedAt: '2026-11-11T00:00:00Z', bodyValues: { 1: { value: 'rozepsáno' } } },
  h1: { ...base, id: 'h1', threadId: 't0', mailboxIds: { inbox: true }, from: [{ email: 'jana@example.cz' }],
    receivedAt: '2025-01-01T00:00:00Z', bodyValues: { 1: { value: 'loni' } } },
  s1: { ...base, id: 's1', threadId: 't9', mailboxIds: { junk: true }, from: [{ email: 'jana@example.cz' }],
    receivedAt: '2025-02-01T00:00:00Z', bodyValues: { 1: { value: 'spam' } } },
};

function fake(missing = false) {
  const requests: Call[][] = [];
  const call: JmapCall = async (calls) => {
    requests.push(calls as Call[]);
    return (calls as Call[]).map(([name, args, tag]) => {
      if (name === 'Email/get') {
        const ids = (args.ids as string[]).filter((id) => !(missing && id === 'cur'));
        return [name, { list: ids.map((id) => emails[id]).filter(Boolean), notFound: [] }, tag];
      }
      if (name === 'Identity/get') return [name, { list: [{ email: 'Info@MarieLuisa.cz' }] }, tag];
      if (name === 'Mailbox/get') {
        return [name, { list: [{ id: 'inbox', role: 'inbox' }, { id: 'sent', role: 'sent' },
          { id: 'drafts', role: 'drafts' }, { id: 'junk', role: 'junk' }] }, tag];
      }
      if (name === 'Thread/get') return [name, { list: [{ id: 't1', emailIds: ['r1', 'cur', 'd1'] }] }, tag];
      if (name === 'Email/query') return [name, { ids: ['cur', 'h1', 's1'] }, tag];
      return ['error', { type: 'unknownMethod' }, tag];
    });
  };
  return { call, requests };
}

describe('loadMailContext', () => {
  it('collects the thread with our sent reply and the guest history, skipping drafts and junk', async () => {
    const { call, requests } = fake();
    const ctx = await loadMailContext({ accountId: 'A', call }, 'cur');
    expect(ctx.current.id).toBe('cur');
    expect(ctx.thread.map((m) => [m.id, m.direction])).toEqual([['r1', 'out']]);
    expect(ctx.history.map((m) => m.id)).toEqual(['h1']);

    const query = requests.flat().find(([n]) => n === 'Email/query')![1];
    expect(query.accountId).toBe('A');
    expect(query.filter).toEqual({ operator: 'OR', conditions: [{ from: 'jana@example.cz' }, { to: 'jana@example.cz' }] });
    expect(query.limit).toBeLessThanOrEqual(30);
  });

  it('asks only for read methods', async () => {
    const { call, requests } = fake();
    await loadMailContext({ accountId: 'A', call }, 'cur');
    for (const [name] of requests.flat()) expect(name).toMatch(/\/(get|query)$/);
  });

  it('reports a mail the account cannot see as not found', async () => {
    const { call } = fake(true);
    await expect(loadMailContext({ accountId: 'A', call }, 'cur')).rejects.toBeInstanceOf(MailNotFoundError);
  });

  it('turns a JMAP method error into a thrown error', async () => {
    const call: JmapCall = async (calls) => calls.map(([, , tag]) => ['error', { type: 'forbidden' }, tag]);
    await expect(loadMailContext({ accountId: 'A', call }, 'cur')).rejects.toThrow(/forbidden/);
  });
});
