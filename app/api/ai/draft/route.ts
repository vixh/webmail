import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { AgentError, askAgent, loadAgentConfig } from '@/lib/ai/agent';
import { loadMailContext, MailNotFoundError } from '@/lib/ai/jmap-context';
import { aiFail, NO_STORE, openJmap, readAiRequest } from '@/lib/ai/request';

// POST /api/ai/draft { emailId }
//
// Loads the mail context as the signed-in user and asks the hotel AI agent for
// a reply draft. The agent extracts the request, checks availability
// read-only, writes the draft and checks it in code (dates, prices, booking
// promises, contacts...). Nothing here sends mail or changes a booking: the
// draft only ever ends up in the reply editor for a person to check and send.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Check {
  code: string;
  level: 'fail' | 'warn';
  msg: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function readChecks(v: unknown): Check[] | null {
  if (!Array.isArray(v)) return null;
  const out: Check[] = [];
  for (const c of v) {
    if (!isObj(c) || typeof c.code !== 'string' || typeof c.msg !== 'string') return null;
    if (c.level !== 'fail' && c.level !== 'warn') return null;
    out.push({ code: c.code, level: c.level, msg: c.msg });
  }
  return out;
}

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

  let data: Record<string, unknown>;
  try {
    // The account scopes what the agent stores, so a later review can only
    // match drafts made for this mailbox.
    data = await askAgent(agent, '/v1/draft', { context, account: creds.username });
  } catch (error) {
    const timeout = error instanceof AgentError && error.timeout;
    logger.warn('AI draft: agent failed', { error: error instanceof Error ? error.message : 'unknown' });
    return timeout ? aiFail(504, 'AI agent timed out') : aiFail(502, 'AI agent unavailable');
  }

  const checks = readChecks(data.checks);
  if (typeof data.draft !== 'string' || !checks) {
    logger.warn('AI draft: malformed agent answer');
    return aiFail(502, 'AI agent unavailable');
  }
  const plan = isObj(data.plan) ? data.plan : {};
  const facts = isObj(data.facts) ? data.facts : {};
  return NextResponse.json({
    draft: data.draft,
    // A failed check always wins over what the agent says about itself.
    ok: data.ok === true && !checks.some((c) => c.level === 'fail'),
    checks,
    status: typeof plan.status === 'string' ? plan.status : 'none',
    ask: strings(plan.ask),
    todo: strings(plan.todo),
    lang: typeof facts.lang === 'string' ? facts.lang : null,
    req: isObj(facts.req) ? facts.req : null,
    avail: isObj(facts.avail) ? facts.avail : null,
    warn: strings(facts.warn),
    context: { guest: context.guest, thread: context.thread.length, history: context.history.length, dropped: context.dropped },
  }, { headers: NO_STORE });
}
