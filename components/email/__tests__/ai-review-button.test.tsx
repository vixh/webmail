import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiReviewButton } from '../ai-review-button';

type Answer = { status: number; body: unknown };
let answers: Answer[];
const calls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  answers = [];
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const a = answers.shift()!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const FOUND = {
  found: true, reviewId: 7,
  diff: {
    ratio: 0.62, added: ['Cena je 1 900 Kč za noc.'], removed: ['Těšíme se.'],
    todo_left: ['parking: v справке нет данных — допишите или удалите'], facts: { dates: [], price: true },
  },
};

async function press(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}

describe('AiReviewButton', () => {
  it('compares the sent reply with its draft and shows what changed', async () => {
    answers.push({ status: 200, body: FOUND });
    render(<AiReviewButton emailId="S1" />);
    await press('ai_review.button');
    expect(calls).toEqual([{ url: '/api/ai/review', body: { emailId: 'S1' } }]);
    expect(screen.getByText(/62/)).toBeTruthy();
    expect(screen.getByText('Cena je 1 900 Kč za noc.')).toBeTruthy();
    expect(screen.getByText('Těšíme se.')).toBeTruthy();
    expect(screen.getByText('ai_review.todo_left')).toBeTruthy();
  });

  it('says when there was no draft and offers no export', async () => {
    answers.push({ status: 200, body: { found: false } });
    render(<AiReviewButton emailId="S1" />);
    await press('ai_review.button');
    expect(screen.getByText('ai_review.no_draft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ai_review.export' })).toBeNull();
  });

  it('exports only after an explicit confirmation and never sends it anywhere itself', async () => {
    answers.push({ status: 200, body: FOUND }, { status: 200, body: { found: true, text: '## Письмо гостя\n<name>' } });
    render(<AiReviewButton emailId="S1" />);
    await press('ai_review.button');
    await press('ai_review.export');
    expect(calls).toHaveLength(1);
    expect(screen.getByText('ai_review.export_warning')).toBeTruthy();
    await press('ai_review.export_confirm');
    expect(calls[1]).toEqual({ url: '/api/ai/export', body: { reviewId: 7 } });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('## Письмо гостя\n<name>');
    expect(calls).toHaveLength(2);
  });

  it('explains a mail that is not our reply', async () => {
    answers.push({ status: 422, body: { error: 'x' } });
    render(<AiReviewButton emailId="S1" />);
    await press('ai_review.button');
    expect(screen.getByText('ai_review.err_not_reply')).toBeTruthy();
  });
});
