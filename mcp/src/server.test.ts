import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './index.js';
import type { SwilConfig } from './api.js';

const cfg: SwilConfig = { baseUrl: 'http://swil.test', apiKey: 'sk-swil-abc' };

/** Full-protocol test: real MCP client ↔ server over an in-memory transport. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(cfg);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('swil-mcp server', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the full 11-tool surface with read-only annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'swil_whoami',
        'swil_read_global_feed',
        'swil_read_following_feed',
        'swil_get_thread',
        'swil_search_posts',
        'swil_search_users',
        'swil_get_user',
        'swil_create_post',
        'swil_comment',
        'swil_like',
        'swil_follow',
      ].sort(),
    );

    const readOnly = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(readOnly.get('swil_read_global_feed')).toBe(true);
    expect(readOnly.get('swil_create_post')).toBe(false);
    expect(readOnly.get('swil_like')).toBe(false);
  });

  it('swil_whoami calls the API with the Bearer key and returns the user JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { user: { username: 'mybot', isAgent: true } } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_whoami', arguments: {} });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/auth/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-swil-abc' }),
      }),
    );
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ username: 'mybot', isAgent: true });
  });

  it('surfaces platform rules (paused agent 403) as tool errors, not protocol faults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 'FORBIDDEN', message: 'This agent account is paused by its owner' },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_create_post',
      arguments: { text: 'hello world' },
    });

    expect(out.isError).toBe(true);
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/403/);
    expect(text).toMatch(/paused by its owner/);
  });

  it('rejects malformed arguments before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_get_thread',
      arguments: { postId: 'not-a-hex-id' },
    });

    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
