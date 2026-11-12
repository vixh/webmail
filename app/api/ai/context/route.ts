import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { loadMailContext, MailNotFoundError, type JmapCall } from '@/lib/ai/jmap-context';
import { checkAiLimit } from '@/lib/ai/limit';

// POST /api/ai/context { emailId }
//
// Collects what the AI reply needs about one mail - the mail, its thread and
// earlier mail with the same guest - through the caller's own JMAP session.
// Off unless AI_REPLY_ENABLED=true, so the route does not exist on a
// deployment that has not opted in.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 4096;
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
const NO_STORE = { 'Cache-Control': 'no-store' };

export function aiReplyEnabled(): boolean {
  return process.env.AI_REPLY_ENABLED === 'true';
}

function fail(status: number, error: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

async function openJmap(creds: StalwartCredentials): Promise<{ accountId: string; call: JmapCall }> {
  const sessionRes = await fetchJmapServer(`${creds.serverUrl}/.well-known/jmap`, {
    headers: { Authorization: creds.authHeader },
  }, creds.trusted);
  if (!sessionRes.ok) throw new Error(`JMAP session ${sessionRes.status}`);
  const session = (await sessionRes.json()) as { apiUrl?: string; primaryAccounts?: Record<string, string> };
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!session.apiUrl || !accountId) throw new Error('JMAP session without a mail account');
  const apiUrl = session.apiUrl;

  const call: JmapCall = async (methodCalls) => {
    const res = await fetchJmapServer(apiUrl, {
      method: 'POST',
      headers: { Authorization: creds.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: USING, methodCalls }),
    }, creds.trusted);
    if (!res.ok) throw new Error(`JMAP ${res.status}`);
    return ((await res.json()) as { methodResponses: Parameters<JmapCall>[0] }).methodResponses;
  };
  return { accountId, call };
}

export async function POST(request: NextRequest) {
  if (!aiReplyEnabled()) return fail(404, 'Not found');

  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  const creds = await getStalwartCredentials(request);
  if (!creds) return fail(401, 'Not authenticated');

  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(413, 'Request too large');
  let emailId: unknown;
  try {
    emailId = (JSON.parse(raw) as { emailId?: unknown }).emailId;
  } catch {
    return fail(400, 'Invalid request body');
  }
  if (typeof emailId !== 'string' || !JMAP_ID.test(emailId)) return fail(400, 'Invalid emailId');

  const limit = checkAiLimit(creds.username);
  if (!limit.allowed) {
    return fail(429, 'Too many requests', { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
  }

  try {
    const jmap = await openJmap(creds);
    const context = await loadMailContext({ ...jmap, username: creds.username }, emailId);
    return NextResponse.json({ context }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MailNotFoundError) return fail(404, 'Mail not found');
    // Details stay in the server log; the browser only learns that it failed.
    logger.warn('AI context failed', { error: error instanceof Error ? error.name : 'unknown' });
    return fail(502, 'Could not load the mail');
  }
}
