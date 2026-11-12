import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { loadMailContext, MailNotFoundError } from '@/lib/ai/jmap-context';
import { aiFail, NO_STORE, openJmap, readAiRequest } from '@/lib/ai/request';

// POST /api/ai/context { emailId }
//
// Collects what the AI reply needs about one mail - the mail, its thread and
// earlier mail with the same guest - through the caller's own JMAP session.
// Off unless AI_REPLY_ENABLED=true, so the route does not exist on a
// deployment that has not opted in.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const input = await readAiRequest(request);
  if (input instanceof NextResponse) return input;
  const { creds, emailId } = input;

  try {
    const jmap = await openJmap(creds);
    const context = await loadMailContext({ ...jmap, username: creds.username }, emailId);
    return NextResponse.json({ context }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MailNotFoundError) return aiFail(404, 'Mail not found');
    // Details stay in the server log; the browser only learns that it failed.
    logger.warn('AI context failed', { error: error instanceof Error ? error.name : 'unknown' });
    return aiFail(502, 'Could not load the mail');
  }
}
