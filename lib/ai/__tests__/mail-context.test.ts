import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { bodyText, buildMailContext, guestAddress, stripQuoted } from '../mail-context';

const own = new Set(['info@marieluisa.cz']);

function mail(over: Partial<Email> & { id: string; text?: string }): Email {
  const { text = '', ...rest } = over;
  return {
    blobId: `b-${over.id}`,
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ name: 'Jana', email: 'jana@example.cz' }],
    to: [{ email: 'info@marieluisa.cz' }],
    subject: 'Pokoj',
    receivedAt: '2026-11-01T10:00:00Z',
    size: 100,
    hasAttachment: false,
    preview: text.slice(0, 50),
    textBody: [{ partId: '1', type: 'text/plain' }],
    bodyValues: { '1': { value: text } },
    ...rest,
  } as unknown as Email;
}

describe('stripQuoted', () => {
  it('drops > lines and everything after a reply header in cs, en and ru', () => {
    expect(stripQuoted('Dobrý den\n\nDne 1. 11. 2026 napsal(a) Hotel:\n> stará zpráva')).toBe('Dobrý den');
    expect(stripQuoted('Thanks!\nOn Mon, 1 Nov 2026 Hotel wrote:\nold')).toBe('Thanks!');
    expect(stripQuoted('Спасибо\n1 нояб. 2026 г., в 10:00, Hotel пишет:\nстарое')).toBe('Спасибо');
    expect(stripQuoted('Hi\n-----Original Message-----\nFrom: x')).toBe('Hi');
    expect(stripQuoted('Hi\n> quoted\nmore')).toBe('Hi\nmore');
  });
});

describe('bodyText', () => {
  it('turns an html-only body into text without tags or scripts', () => {
    const e = mail({ id: 'h', textBody: [{ partId: '2', type: 'text/html' }] as Email['textBody'],
      bodyValues: { '2': { value: '<p>Máte <b>pokoj</b>?</p><script>x()</script><style>p{}</style>' } } as Email['bodyValues'] });
    expect(bodyText(e)).toBe('Máte pokoj?');
  });

  it('falls back to the preview when the body was not fetched', () => {
    expect(bodyText(mail({ id: 'p', bodyValues: undefined, preview: 'jen náhled' } as never))).toBe('jen náhled');
  });
});

describe('guestAddress', () => {
  it('is the sender of an incoming mail and the recipient of our own', () => {
    expect(guestAddress(mail({ id: 'a' }), own)).toBe('jana@example.cz');
    expect(guestAddress(mail({ id: 'b', from: [{ email: 'INFO@marieluisa.cz' }], to: [{ email: 'Jana@Example.cz' }] }), own))
      .toBe('jana@example.cz');
  });

  it('prefers Reply-To on an incoming mail', () => {
    expect(guestAddress(mail({ id: 'c', replyTo: [{ email: 'group@agency.cz' }] }), own)).toBe('group@agency.cz');
  });
});

describe('buildMailContext', () => {
  const current = mail({ id: 'cur', receivedAt: '2026-11-10T09:00:00Z', text: 'Máte jednolůžkový pokoj 18.–19. 11.?\n> citace' });
  const ourReply = mail({ id: 'r1', receivedAt: '2026-11-05T12:00:00Z', from: [{ email: 'info@marieluisa.cz' }],
    to: [{ email: 'jana@example.cz' }], text: 'Dobrý den, ano.' });
  const first = mail({ id: 'q1', receivedAt: '2026-11-05T08:00:00Z', text: 'Dotaz' });

  it('puts the thread in date order without the current mail and marks direction', () => {
    const ctx = buildMailContext({ email: current, thread: [current, ourReply, first], history: [], own });
    expect(ctx.current).toMatchObject({ id: 'cur', direction: 'in', text: 'Máte jednolůžkový pokoj 18.–19. 11.?' });
    expect(ctx.thread.map((m) => [m.id, m.direction])).toEqual([['q1', 'in'], ['r1', 'out']]);
    expect(ctx.guest).toBe('jana@example.cz');
  });

  it('keeps history apart from the thread, newest first, without duplicates', () => {
    const old = mail({ id: 'h1', threadId: 't0', receivedAt: '2025-03-01T00:00:00Z', subject: 'Skupina 25 osob', text: 'cena 1500 Kč' });
    const older = mail({ id: 'h2', threadId: 't0', receivedAt: '2024-03-01T00:00:00Z', text: 'x' });
    const ctx = buildMailContext({ email: current, thread: [current, first], history: [older, first, old, current], own });
    expect(ctx.history.map((m) => m.id)).toEqual(['h1', 'h2']);
    expect(ctx.history[0].source).toBe('history');
    expect(ctx.thread[0].source).toBe('thread');
  });

  it('cuts long bodies and drops the oldest history first when over budget', () => {
    const long = 'a'.repeat(10_000);
    const hist = Array.from({ length: 10 }, (_, i) => mail({ id: `h${i}`, threadId: `t${i}`,
      receivedAt: `2025-0${(i % 9) + 1}-01T00:00:00Z`, text: long }));
    const ctx = buildMailContext({ email: mail({ id: 'cur', text: long }), thread: [], history: hist, own,
      limits: { current: 4000, thread: 1500, history: 800, total: 8000 } });
    expect(ctx.current.text.length).toBeLessThanOrEqual(4001);
    expect(ctx.current.truncated).toBe(true);
    const size = ctx.current.text.length + ctx.history.reduce((n, m) => n + m.text.length, 0);
    expect(size).toBeLessThanOrEqual(8000);
    expect(ctx.history[0].id).toBe('h8');
    expect(ctx.dropped).toBeGreaterThan(0);
  });
});
