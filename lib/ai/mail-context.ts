import type { Email, EmailAddress } from '@/lib/jmap/types';

// Picks the part of a mailbox an AI reply needs: the opened mail, the rest of
// its thread (our sent replies included) and earlier mail with the same guest.
// Everything here is guest-supplied text - it is data for the model, never
// instructions - and it is cut to a fixed budget so a long history cannot
// crowd out the mail being answered.

export type MailSource = 'current' | 'thread' | 'history';

export interface MailItem {
  id: string;
  threadId: string;
  date: string;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  subject: string;
  text: string;
  truncated: boolean;
  source: MailSource;
}

export interface MailContext {
  guest: string | null;
  current: MailItem;
  thread: MailItem[];
  history: MailItem[];
  /** Messages left out to stay within the budget. */
  dropped: number;
}

export interface ContextLimits {
  current: number;
  thread: number;
  history: number;
  total: number;
}

export const DEFAULT_LIMITS: ContextLimits = { current: 6000, thread: 2500, history: 1200, total: 30_000 };

// A line that opens the quoted previous message in cs, en, ru and Outlook form.
const REPLY_HEADERS = [
  /^On .+wrote:\s*$/i,
  /^Dne .+napsal.*:\s*$/i,
  /(пишет|написал|написала|написал\(а\)):\s*$/i,
  /^-{2,}\s*(Original Message|Původní zpráva|Původní e-mail|Исходное сообщение|Forwarded message|Přeposlaná zpráva)/i,
  /^_{10,}\s*$/,
];

export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bare = line.trim();
    if (REPLY_HEADERS.some((re) => re.test(bare))) break;
    if (bare.startsWith('>')) continue;
    out.push(line.trimEnd());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function bodyText(email: Email): string {
  const values = email.bodyValues;
  if (!values) return email.preview ?? '';
  const parts = (email.textBody ?? []).flatMap((part) => {
    const value = part.partId ? values[part.partId]?.value : undefined;
    if (!value) return [];
    return [part.type === 'text/html' ? htmlToText(value) : value];
  });
  return parts.length ? parts.join('\n').trim() : (email.preview ?? '');
}

const addr = (a?: EmailAddress) => (a?.email ?? '').trim().toLowerCase();

export function isOwn(email: Email, own: ReadonlySet<string>): boolean {
  return own.has(addr(email.from?.[0]));
}

export function guestAddress(email: Email, own: ReadonlySet<string>): string | null {
  const pick = (list?: EmailAddress[]) => (list ?? []).map(addr).find((a) => a && !own.has(a));
  if (isOwn(email, own)) return pick(email.to) ?? pick(email.cc) ?? null;
  return pick(email.replyTo) ?? pick(email.from) ?? null;
}

function cut(text: string, max: number): [string, boolean] {
  return text.length > max ? [text.slice(0, max) + '…', true] : [text, false];
}

function toItem(email: Email, own: ReadonlySet<string>, source: MailSource, max: number): MailItem {
  const [text, truncated] = cut(stripQuoted(bodyText(email)), max);
  return {
    id: email.id,
    threadId: email.threadId,
    date: email.receivedAt ?? email.sentAt ?? '',
    direction: isOwn(email, own) ? 'out' : 'in',
    from: addr(email.from?.[0]),
    to: (email.to ?? []).map(addr).filter(Boolean),
    subject: email.subject ?? '',
    text,
    truncated,
    source,
  };
}

const byDate = (a: MailItem, b: MailItem) => a.date.localeCompare(b.date);

export function buildMailContext(input: {
  email: Email;
  thread: Email[];
  history: Email[];
  own: ReadonlySet<string>;
  limits?: ContextLimits;
}): MailContext {
  const { email, own } = input;
  const limits = input.limits ?? DEFAULT_LIMITS;
  const current = toItem(email, own, 'current', limits.current);

  const seen = new Set([email.id]);
  const thread = input.thread
    .filter((e) => !seen.has(e.id) && (seen.add(e.id), true))
    .map((e) => toItem(e, own, 'thread', limits.thread))
    .sort(byDate);
  const history = input.history
    .filter((e) => e.threadId !== email.threadId && !seen.has(e.id) && (seen.add(e.id), true))
    .map((e) => toItem(e, own, 'history', limits.history))
    .sort((a, b) => byDate(b, a));

  // Over budget: the oldest history goes first, then the oldest thread mail.
  const size = () => [current, ...thread, ...history].reduce((n, m) => n + m.text.length, 0);
  let dropped = 0;
  while (size() > limits.total && (history.length || thread.length)) {
    if (history.length) history.pop();
    else thread.shift();
    dropped++;
  }

  return { guest: guestAddress(email, own), current, thread, history, dropped };
}
