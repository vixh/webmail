import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

describe('replying to selected message text', () => {
  it('passes only the selected plain-text fragment to the reply opener', () => {
    const email = {
      id: 'selected', blobId: 'b-selected', threadId: 't-selected', mailboxIds: { inbox: true },
      keywords: { $seen: true }, from: [{ name: 'Alice', email: 'alice@example.com' }],
      to: [{ email: 'me@example.com' }], subject: 'Selection', receivedAt: '2026-01-01T00:00:00Z',
      preview: 'Keep only this phrase', hasAttachment: false, size: 100,
      textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
      attachments: [], bodyValues: { '1': { value: 'Keep only this phrase' } },
    } as unknown as Email;
    const onReply = vi.fn();
    const { container } = render(
      <EmailViewer
        email={email}
        onReply={onReply}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
      />,
    );

    const body = container.querySelector('.email-content-text')!;
    const text = body.firstChild!;
    const range = document.createRange();
    range.setStart(text, 10);
    range.setEnd(text, 14);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const reply = screen.getByTitle('tooltips.reply');
    fireEvent.pointerDown(reply);
    fireEvent.click(reply);

    expect(onReply).toHaveBeenCalledWith(undefined, { body: 'this' });
  });
});
