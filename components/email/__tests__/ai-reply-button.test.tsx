import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiReplyButton } from '../ai-reply-button';

type Answer = { status: number; body: unknown };
let answers: Array<Answer | Promise<Answer>>;
const calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  answers = [];
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = await answers.shift()!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const OK = {
  draft: 'Dobrý den,\n\nmáme volno.\n\n[[цена: укажите сами]]', ok: true, status: 'available',
  checks: [{ code: 'todo', level: 'warn', msg: 'есть места [[…]], которые нужно дописать' }],
  ask: [], todo: ['цена: укажите сами'], warn: [],
};

async function click() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /ai_reply\.button/ }));
  });
}

describe('AiReplyButton', () => {
  it('asks for a draft of this mail and puts a checked draft into the reply editor', async () => {
    answers.push({ status: 200, body: OK });
    const onUse = vi.fn();
    render(<AiReplyButton emailId="M1" onUse={onUse} />);
    await click();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/ai/draft');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ emailId: 'M1' });
    expect(onUse).toHaveBeenCalledWith(OK.draft);
    expect(screen.getByText('есть места [[…]], которые нужно дописать')).toBeTruthy();
  });

  it('keeps a draft that failed the checks out of the editor until asked', async () => {
    answers.push({ status: 200, body: { ...OK, ok: false, checks: [{ code: 'price', level: 'fail', msg: 'в ответе есть цена' }] } });
    const onUse = vi.fn();
    render(<AiReplyButton emailId="M1" onUse={onUse} />);
    await click();
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByText('в ответе есть цена')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ai_reply.use_anyway' }));
    expect(onUse).toHaveBeenCalledWith(OK.draft);
  });

  it('sends one request however often it is clicked while waiting', async () => {
    let release!: (a: Answer) => void;
    answers.push(new Promise<Answer>((r) => { release = r; }));
    render(<AiReplyButton emailId="M1" onUse={vi.fn()} />);
    await click();
    await click();
    expect(calls).toHaveLength(1);
    await act(async () => release({ status: 200, body: OK }));
  });

  it('says what went wrong and never opens the editor on errors', async () => {
    const onUse = vi.fn();
    for (const [status, key] of [[503, 'err_not_configured'], [504, 'err_timeout'], [429, 'err_busy'], [500, 'err_generic']] as const) {
      answers.push({ status, body: { error: 'x' } });
      const { unmount } = render(<AiReplyButton emailId="M1" onUse={onUse} />);
      await click();
      expect(screen.getByText(`ai_reply.${key}`)).toBeTruthy();
      unmount();
    }
    expect(onUse).not.toHaveBeenCalled();
  });

  it('drops an answer that arrives after another mail was opened', async () => {
    let release!: (a: Answer) => void;
    answers.push(new Promise<Answer>((r) => { release = r; }));
    const onUse = vi.fn();
    const { rerender } = render(<AiReplyButton emailId="M1" onUse={onUse} />);
    await click();
    rerender(<AiReplyButton emailId="M2" onUse={onUse} />);
    await act(async () => release({ status: 200, body: OK }));
    expect(onUse).not.toHaveBeenCalled();
  });
});
