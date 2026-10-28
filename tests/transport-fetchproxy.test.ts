import { describe, expect, it, vi } from 'vitest';
import type { FetchproxyTransport as InnerTransport } from '@chrischall/mcp-utils/fetchproxy';
import { DEFAULT_PORT, FetchproxyTransport } from '../src/transport-fetchproxy.js';

interface InnerCall {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeFake(): { inner: InnerTransport; calls: InnerCall[]; factoryArgs: unknown[] } {
  const calls: InnerCall[] = [];
  const inner = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    status: vi.fn(() => ({ role: 'host' })),
    runProbe: vi.fn(async (fetchFn: (p: string) => Promise<unknown>, path: string) => {
      await fetchFn(path);
      return { ok: true, elapsed_ms: 1 };
    }),
    fetch: vi.fn(async (init: InnerCall) => {
      calls.push(init);
      return { status: 200, body: '{"data":[]}', url: `https://pfbhintouch.insynchcs.com${init.path}` };
    }),
  } as unknown as InnerTransport;
  return { inner, calls, factoryArgs: [] };
}

function make(): {
  t: FetchproxyTransport;
  calls: InnerCall[];
  inner: InnerTransport;
  factoryArgs: unknown[];
} {
  const { inner, calls, factoryArgs } = makeFake();
  const t = new FetchproxyTransport({
    subdomain: 'pfbhintouch',
    version: '1.2.3',
    createInner: ((opts: unknown) => {
      factoryArgs.push(opts);
      return inner;
    }) as never,
  });
  return { t, calls, inner, factoryArgs };
}

describe('FetchproxyTransport', () => {
  it('builds the inner transport with the fleet port, domain and subdomain', () => {
    const { factoryArgs } = make();
    expect(factoryArgs[0]).toMatchObject({
      port: DEFAULT_PORT,
      serverName: 'insync-mcp',
      version: '1.2.3',
      domains: ['insynchcs.com'],
      defaultSubdomain: 'pfbhintouch',
    });
  });

  it('never exposes an S3 config', () => {
    expect(make().t.getS3Config()).toBeUndefined();
  });

  it('delegates lifecycle, status and runProbe to the inner transport', async () => {
    const { t, inner } = make();
    await t.start();
    await t.close();
    expect(t.status()).toEqual({ role: 'host' });
    expect(inner.start).toHaveBeenCalled();
    expect(inner.close).toHaveBeenCalled();
    const fetchFn = vi.fn(async () => 'page');
    await t.runProbe(fetchFn, 'Dashboard');
    expect(fetchFn).toHaveBeenCalledWith('Dashboard');
  });

  it('sends a JSON read with XRW and the right content type', async () => {
    const { t, calls } = make();
    await t.getJson('Dashboard/GetDashBoradCount', { headers: { 'X-Extra': '1' } });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/Dashboard/GetDashBoradCount',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', 'X-Extra': '1' },
    });
  });

  it('sends getText, postJson, postText and postForm (both body forms)', async () => {
    const { t, calls } = make();
    await t.getText('SurveyForms/GetReceivedSurveyForms');
    await t.postJson('Dashboard/GetPateintBalance', { a: 1 });
    await t.postText('X', 'raw');
    await t.postForm('Y', { k: 'v' });
    await t.postForm('/Z', new URLSearchParams({ m: 'n' }));
    expect(calls[0]).toMatchObject({ method: 'GET', headers: { Accept: 'text/html' } });
    expect(calls[1]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/X', body: 'raw' });
    expect(calls[3]).toMatchObject({ body: 'k=v', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(calls[4]).toMatchObject({ path: '/Z', body: 'm=n' });
  });

  it('returns the inner status/body/url triple', async () => {
    const { t } = make();
    const res = await t.getJson('A');
    expect(res).toEqual({ status: 200, body: '{"data":[]}', url: 'https://pfbhintouch.insynchcs.com/A' });
  });

  it('refuses binary downloads — the bridge relays text only', async () => {
    const { t } = make();
    await expect(t.getBinary()).rejects.toThrow(/not available over the browser bridge/);
    await expect(t.postBinary()).rejects.toThrow(/not available over the browser bridge/);
    await expect(t.getBinary()).rejects.toMatchObject({
      hint: expect.stringContaining('INSYNC_USERNAME'),
    });
  });
});
