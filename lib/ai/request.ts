import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import type { JmapCall } from './jmap-context';
import { aiReplyEnabled } from './flag';
import { checkAiLimit } from './limit';

// Shared front door of the /api/ai/* routes: feature flag, same-origin and
// session gates, the { emailId } body and the request budget. Everything
// after it runs as the signed-in user through their own JMAP session.

const MAX_BODY = 4096;
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
export const NO_STORE = { 'Cache-Control': 'no-store' };

export { aiReplyEnabled };

export function aiFail(status: number, error: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

export async function readAiRequest(
  request: NextRequest,
): Promise<{ creds: StalwartCredentials; emailId: string } | NextResponse> {
  if (!aiReplyEnabled()) return aiFail(404, 'Not found');

  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  const creds = await getStalwartCredentials(request);
  if (!creds) return aiFail(401, 'Not authenticated');

  const raw = await request.text();
  if (raw.length > MAX_BODY) return aiFail(413, 'Request too large');
  let emailId: unknown;
  try {
    emailId = (JSON.parse(raw) as { emailId?: unknown }).emailId;
  } catch {
    return aiFail(400, 'Invalid request body');
  }
  if (typeof emailId !== 'string' || !JMAP_ID.test(emailId)) return aiFail(400, 'Invalid emailId');

  const limit = checkAiLimit(creds.username);
  if (!limit.allowed) {
    return aiFail(429, 'Too many requests', { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
  }
  return { creds, emailId };
}

export async function openJmap(creds: StalwartCredentials): Promise<{ accountId: string; call: JmapCall }> {
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
