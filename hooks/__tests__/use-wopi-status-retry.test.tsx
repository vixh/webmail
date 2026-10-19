import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('useWopiStatus session bootstrap', () => {
  it('retries a transient 401 instead of caching WOPI as disabled', async () => {
    vi.useFakeTimers();
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ enabled: true, editExtensions: ['docx'], viewExtensions: ['pdf'] }),
      });
    vi.doMock('@/lib/browser-navigation', () => ({ apiFetch }));
    const { useWopiStatus } = await import('@/hooks/use-wopi-status');
    const { result } = renderHook(() => useWopiStatus(true));

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current?.enabled).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
