import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { ZipPreview } from '@/components/files/zip-preview';

async function archiveBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file('documents/invoice.pdf', new Uint8Array([37, 80, 68, 70]));
  return zip.generateAsync({ type: 'blob' });
}

describe('ZipPreview', () => {
  it('keeps archive actions inside the modal and exposes an extracted entry', async () => {
    const onBackgroundClick = vi.fn();
    const onPreviewEntry = vi.fn();
    const blob = await archiveBlob();

    render(
      <div onClick={onBackgroundClick}>
        <ZipPreview blob={blob} onPreviewEntry={onPreviewEntry} />
      </div>,
    );

    const preview = await screen.findByRole('button', { name: 'Preview documents/invoice.pdf' });
    fireEvent.click(preview);
    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(onPreviewEntry).toHaveBeenCalledTimes(1);

    const entry = onPreviewEntry.mock.calls[0][0];
    expect(entry.name).toBe('invoice.pdf');
    await waitFor(async () => {
      const content = await entry.getFileContent();
      expect(content.blob.size).toBe(4);
    });
  });
});
