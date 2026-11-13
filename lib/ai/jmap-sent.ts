import type { Email } from '@/lib/jmap/types';
import { MailNotFoundError, result, type JmapCall } from './jmap-context';
import { bodyText, firstMessageId, isOwn, stripQuoted } from './mail-context';

// Reads a reply we sent, for comparing it with the AI draft it started from:
// the text that really went out (quote removed) and the Message-ID it answers.
// Read-only, through the signed-in user's own JMAP session.

export class NotOurReplyError extends Error {
  constructor() {
    super('Not sent from this mailbox');
    this.name = 'NotOurReplyError';
  }
}

export class NotAReplyError extends Error {
  constructor() {
    super('Not a reply');
    this.name = 'NotAReplyError';
  }
}

const PROPS = ['id', 'from', 'inReplyTo', 'textBody', 'bodyValues', 'preview'];

export async function loadSentReply(
  jmap: { accountId: string; call: JmapCall; username?: string },
  emailId: string,
): Promise<{ sentId: string; inReplyTo: string; final: string }> {
  const { accountId, call } = jmap;
  const res = await call([
    ['Email/get', { accountId, ids: [emailId], properties: PROPS, fetchTextBodyValues: true, maxBodyValueBytes: 64 * 1024 }, 'e'],
    ['Identity/get', { accountId }, 'i'],
  ]);
  const email = result<{ list: Email[] }>(res, 'e').list.find((e) => e.id === emailId);
  if (!email) throw new MailNotFoundError();

  const own = new Set<string>();
  for (const id of result<{ list: Array<{ email?: string }> }>(res, 'i').list) {
    if (id.email) own.add(id.email.trim().toLowerCase());
  }
  if (jmap.username?.includes('@')) own.add(jmap.username.trim().toLowerCase());
  if (!isOwn(email, own)) throw new NotOurReplyError();

  const inReplyTo = firstMessageId(email.inReplyTo);
  if (!inReplyTo) throw new NotAReplyError();
  return { sentId: email.id, inReplyTo, final: stripQuoted(bodyText(email)) };
}
