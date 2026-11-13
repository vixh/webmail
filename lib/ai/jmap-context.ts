import type { Email } from '@/lib/jmap/types';
import { buildMailContext, guestAddress, type ContextLimits, type MailContext } from './mail-context';

// Reads the mail context for an AI reply through the signed-in user's own
// JMAP session: only /get and /query methods, so this path can never change
// the mailbox, and it sees exactly what the user already sees.

export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapCall = (calls: JmapMethodCall[]) => Promise<JmapMethodCall[]>;

export class MailNotFoundError extends Error {
  constructor() {
    super('Mail not found');
    this.name = 'MailNotFoundError';
  }
}

const THREAD_MAX = 30;
const HISTORY_MAX = 20;
const BODY_BYTES = 64 * 1024;
// Mail in these folders is not part of the conversation with the guest.
const SKIP_ROLES = new Set(['drafts', 'junk', 'trash']);

const EMAIL_PROPS = ['id', 'threadId', 'mailboxIds', 'from', 'to', 'cc', 'replyTo', 'subject', 'receivedAt',
  'sentAt', 'messageId', 'inReplyTo', 'references', 'preview', 'textBody', 'bodyValues'];

export function result<T>(responses: JmapMethodCall[], tag: string): T {
  const hit = responses.find(([, , t]) => t === tag);
  if (!hit) throw new Error(`JMAP response ${tag} missing`);
  if (hit[0] === 'error') throw new Error(`JMAP ${tag} failed: ${String(hit[1].type ?? 'error')}`);
  return hit[1] as T;
}

export async function loadMailContext(
  jmap: { accountId: string; call: JmapCall; username?: string },
  emailId: string,
  limits?: ContextLimits,
): Promise<MailContext> {
  const { accountId, call } = jmap;
  const getEmails = (ids: string[]): Record<string, unknown> => ({
    accountId, ids, properties: EMAIL_PROPS, fetchTextBodyValues: true, maxBodyValueBytes: BODY_BYTES,
  });

  const first = await call([
    ['Email/get', getEmails([emailId]), 'e'],
    ['Identity/get', { accountId }, 'i'],
    ['Mailbox/get', { accountId, ids: null, properties: ['id', 'role'] }, 'm'],
  ]);
  const email = result<{ list: Email[] }>(first, 'e').list.find((e) => e.id === emailId);
  if (!email) throw new MailNotFoundError();

  const own = new Set<string>();
  for (const id of result<{ list: Array<{ email?: string }> }>(first, 'i').list) {
    if (id.email) own.add(id.email.trim().toLowerCase());
  }
  if (jmap.username?.includes('@')) own.add(jmap.username.trim().toLowerCase());

  const skip = new Set(result<{ list: Array<{ id: string; role?: string | null }> }>(first, 'm').list
    .filter((m) => m.role && SKIP_ROLES.has(m.role)).map((m) => m.id));
  const keep = (e: Email) => !Object.keys(e.mailboxIds ?? {}).some((id) => skip.has(id));

  const guest = guestAddress(email, own);
  const second = await call([
    ['Thread/get', { accountId, ids: [email.threadId] }, 't'],
    ...(guest ? [['Email/query', {
      accountId,
      filter: { operator: 'OR', conditions: [{ from: guest }, { to: guest }] },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: HISTORY_MAX,
    }, 'q'] as JmapMethodCall] : []),
  ]);
  const threadIds = (result<{ list: Array<{ emailIds: string[] }> }>(second, 't').list[0]?.emailIds ?? [])
    .slice(-THREAD_MAX);
  const historyIds = guest ? result<{ ids: string[] }>(second, 'q').ids : [];

  const wanted = [...new Set([...threadIds, ...historyIds])].filter((id) => id !== emailId);
  const bodies = wanted.length
    ? result<{ list: Email[] }>(await call([['Email/get', getEmails(wanted), 'b']]), 'b').list.filter(keep)
    : [];
  const inThread = new Set(threadIds);

  return buildMailContext({
    email,
    thread: bodies.filter((e) => inThread.has(e.id)),
    history: bodies.filter((e) => !inThread.has(e.id)),
    own,
    limits,
  });
}
