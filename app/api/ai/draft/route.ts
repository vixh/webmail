import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { AgentError, askAgent, loadAgentConfig } from '@/lib/ai/agent';
import { loadMailContext, MailNotFoundError } from '@/lib/ai/jmap-context';
import { aiFail, NO_STORE, openJmap, readAiRequest } from '@/lib/ai/request';

// POST /api/ai/draft { emailId }
//
// Loads the mail context as the signed-in user and hands it to the hotel AI
// agent, which extracts the guest's request and checks live availability
// (read-only). Nothing here sends mail or changes a booking: the result only
// ever ends up in the reply editor for a person to check and send.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const input = await readAiRequest(request);
  if (input instanceof NextResponse) return input;
  const { creds, emailId } = input;

  const agent = loadAgentConfig();
  if (!agent) return aiFail(503, 'AI agent is not configured');

  let context;
  try {
    const jmap = await openJmap(creds);
    context = await loadMailContext({ ...jmap, username: creds.username }, emailId);
  } catch (error) {
    if (error instanceof MailNotFoundError) return aiFail(404, 'Mail not found');
    logger.warn('AI draft: context failed', { error: error instanceof Error ? error.name : 'unknown' });
    return aiFail(502, 'Could not load the mail');
  }

  try {
    const facts = await askAgent(agent, context);
    return NextResponse.json({
      facts,
      context: { guest: context.guest, thread: context.thread.length, history: context.history.length, dropped: context.dropped },
    }, { headers: NO_STORE });
  } catch (error) {
    const timeout = error instanceof AgentError && error.timeout;
    logger.warn('AI draft: agent failed', { error: error instanceof Error ? error.message : 'unknown' });
    return timeout ? aiFail(504, 'AI agent timed out') : aiFail(502, 'AI agent unavailable');
  }
}
