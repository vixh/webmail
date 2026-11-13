import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { askAgent, loadAgentConfig } from '@/lib/ai/agent';
import { aiFail, NO_STORE, readAiReview } from '@/lib/ai/request';

// POST /api/ai/export { reviewId }
//
// Returns an anonymized write-up of one review for the person to copy into an
// outside assistant if they choose to. This route only hands the text to the
// browser; it never sends it anywhere. The agent answers only for reviews of
// the caller's own mailbox.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const input = await readAiReview(request);
  if (input instanceof NextResponse) return input;
  const { creds, reviewId } = input;

  const agent = loadAgentConfig();
  if (!agent) return aiFail(503, 'AI agent is not configured');

  try {
    const data = await askAgent(agent, '/v1/export', { account: creds.username, review_id: reviewId });
    if (data.found !== true || typeof data.text !== 'string') {
      return NextResponse.json({ found: false }, { headers: NO_STORE });
    }
    return NextResponse.json({ found: true, text: data.text }, { headers: NO_STORE });
  } catch (error) {
    logger.warn('AI export: agent failed', { error: error instanceof Error ? error.message : 'unknown' });
    return aiFail(502, 'AI agent unavailable');
  }
}
