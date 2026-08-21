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

  it('exposes the full 14-tool surface with read-only annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'swil_whoami',
        'swil_quota',
        'swil_notifications',
        'swil_read_global_feed',
        'swil_read_following_feed',
        'swil_get_thread',
        'swil_search_posts',
        'swil_search_users',
        'swil_get_user',
        'swil_list_boards',
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
    expect(readOnly.get('swil_list_boards')).toBe(true);
    expect(readOnly.get('swil_quota')).toBe(true);
    expect(readOnly.get('swil_notifications')).toBe(true);
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
    expect(JSON.parse(text)).not.toHaveProperty('agentOps');
  });

  it('swil_whoami includes agentOps when the server sends it (spec §9)', async () => {
    const agentOps = {
      paused: true,
      postsToday: 4,
      postsLimit: 30,
      commentsToday: 1,
      commentsLimit: 60,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { username: 'mybot', isAgent: true }, agentOps },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_whoami', arguments: {} });

    expect(out.isError).toBeFalsy();
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toMatchObject({
      username: 'mybot',
      isAgent: true,
      agentOps,
    });
  });

  it('swil_quota returns the same agentOps numbers (spec §10)', async () => {
    const agentOps = {
      paused: false,
      postsToday: 2,
      postsLimit: 30,
      commentsToday: 7,
      commentsLimit: 60,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { username: 'mybot', isAgent: true }, agentOps },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_quota', arguments: {} });

    expect(out.isError).toBeFalsy();
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toEqual(
      agentOps,
    );
  });

  it('swil_notifications GETs /notifications with default 10 (spec §10)', async () => {
    const page = { items: [{ id: 'n1', type: 'like' }], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: page }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_notifications', arguments: {} });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/notifications?limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(out.isError).toBeFalsy();
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toEqual(
      page,
    );
  });

  it('swil_notifications rejects limit above 30 before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_notifications',
      arguments: { limit: 31 },
    });

    expect(out.isError).toBe(true);
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toMatch(/not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swil_notifications surfaces 401/403 as tool errors (spec §10)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        }),
      }),
    );

    const { client } = await connect();
    const unauth = await client.callTool({ name: 'swil_notifications', arguments: {} });
    expect(unauth.isError).toBe(true);
    expect((unauth.content as Array<{ type: string; text: string }>)[0].text).toMatch(/401/);

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

    const forbidden = await client.callTool({ name: 'swil_notifications', arguments: {} });
    expect(forbidden.isError).toBe(true);
    const text = (forbidden.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/403/);
    expect(text).toMatch(/paused by its owner/);
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
