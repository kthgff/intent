// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapAuth, getToken, setToken } from '../src/api';
import { client } from '../src/api';

describe('auth', () => {
  afterEach(() => {
    setToken(null);
    vi.restoreAllMocks();
  });

  it('attaches Authorization: Bearer on every request', async () => {
    setToken('deadbeef');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    await client.inbox();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer deadbeef',
    );
  });

  it('bootstrapAuth stores ?token= and strips it from the URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html></html>', { status: 200 }),
    );
    window.history.replaceState(null, '', '/?token=cafe1234&x=1');
    const token = await bootstrapAuth(window.location.search);
    expect(token).toBe('cafe1234');
    expect(getToken()).toBe('cafe1234');
    expect(window.location.search).toBe('?x=1');
    // bootstrap call hit the loopback cookie route
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toBe('/?token=cafe1234');
  });

  it('throws ApiError with server error payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'stale' }), {
        status: 409,
      }),
    );
    await expect(client.inbox()).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'stale',
    });
  });
});
