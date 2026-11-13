import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { AgentError, askAgent, loadAgentConfig } from '@/lib/ai/agent';
import { MailNotFoundError } from '@/lib/ai/jmap-context';
import { loadSentReply, NotAReplyError, NotOurReplyError } from '@/lib/ai/jmap-sent';
import { aiFail, NO_STORE, openJmap, readAiRequest } from '@/lib/ai/request';

// POST /api/ai/review { emailId }  - emailId of a reply we sent
//
// Compares what really went out with the AI draft it started from. The agent
// keeps the pair: the staff's text becomes an example for similar mail later.
// Nothing leaves the hotel's servers here.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const input = await readAiRequest(request);
  if (input instanceof NextResponse) return input;
  const { creds, emailId } = input;

  const agent = loadAgentConfig();
  if (!agent) return aiFail(503, 'AI agent is not configured');

  let sent;
  try {
    const jmap = await openJmap(creds);
    sent = await loadSentReply({ ...jmap, username: creds.username }, emailId);
  } catch (error) {
    if (error instanceof MailNotFoundError) return aiFail(404, 'Mail not found');
    if (error instanceof NotOurReplyError) return aiFail(422, 'Not sent from this mailbox');
    if (error instanceof NotAReplyError) return aiFail(422, 'Not a reply');
    logger.warn('AI review: mail failed', { error: error instanceof Error ? error.name : 'unknown' });
    return aiFail(502, 'Could not load the mail');
  }

  try {
    const data = await askAgent(agent, '/v1/review', {
      account: creds.username, msgid: sent.inReplyTo, sent_id: sent.sentId, final: sent.final,
    });
    if (data.found !== true) return NextResponse.json({ found: false }, { headers: NO_STORE });
    return NextResponse.json({ found: true, reviewId: data.review_id, diff: data.diff }, { headers: NO_STORE });
  } catch (error) {
    const timeout = error instanceof AgentError && error.timeout;
    logger.warn('AI review: agent failed', { error: error instanceof Error ? error.message : 'unknown' });
    return timeout ? aiFail(504, 'AI agent timed out') : aiFail(502, 'AI agent unavailable');
  }
}
