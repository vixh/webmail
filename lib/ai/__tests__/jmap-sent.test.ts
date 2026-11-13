import { describe, expect, it } from 'vitest';
import { loadSentReply, NotAReplyError, NotOurReplyError } from '../jmap-sent';
import { MailNotFoundError, type JmapCall } from '../jmap-context';

type Call = [string, Record<string, unknown>, string];

function fake(email: Record<string, unknown> | null) {
  const names: string[] = [];
  const call: JmapCall = async (calls) => (calls as Call[]).map(([name, , tag]) => {
    names.push(name);
    if (name === 'Email/get') return [name, { list: email ? [email] : [] }, tag];
    if (name === 'Identity/get') return [name, { list: [{ email: 'hotel@marie-luisa.cz' }] }, tag];
    return ['error', { type: 'unknownMethod' }, tag];
  });
  return { call, names };
}

const SENT = {
  id: 'S1', threadId: 'T', mailboxIds: { sent: true }, inReplyTo: ['a1@example.cz'],
  from: [{ email: 'Hotel@Marie-Luisa.cz' }], to: [{ email: 'guest@example.cz' }],
  textBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { 1: { value: 'Dobrý den,\npokoj je volný.\n\nDne 12. 11. 2026 napsal(a) Host:\n> Máte pokoj?' } },
};

describe('loadSentReply', () => {
  it('returns our sent text without the quote and the Message-ID it answers', async () => {
    const { call, names } = fake(SENT);
    const r = await loadSentReply({ accountId: 'A', call }, 'S1');
    expect(r).toEqual({ sentId: 'S1', inReplyTo: '<a1@example.cz>', final: 'Dobrý den,\npokoj je volný.' });
    for (const n of names) expect(n).toMatch(/\/get$/);
  });

  it('refuses mail that is not ours, not a reply, or not visible', async () => {
    await expect(loadSentReply({ accountId: 'A', call: fake({ ...SENT, from: [{ email: 'guest@example.cz' }] }).call }, 'S1'))
      .rejects.toBeInstanceOf(NotOurReplyError);
    await expect(loadSentReply({ accountId: 'A', call: fake({ ...SENT, inReplyTo: null }).call }, 'S1'))
      .rejects.toBeInstanceOf(NotAReplyError);
    await expect(loadSentReply({ accountId: 'A', call: fake(null).call }, 'S1')).rejects.toBeInstanceOf(MailNotFoundError);
  });
});
