// Adapter letting @fetchproxy/server satisfy InsyncTransport.
//
// Requests run inside the user's own signed-in portal tab, so this server never
// holds the session cookie or the credentials — and never captures the S3 creds
// (getS3Config is always undefined on this path). The verb surface comes from
// the shared `createFetchproxyTransport` in @chrischall/mcp-utils/fetchproxy;
// the import of @fetchproxy/server it pulls in only loads when this transport is
// actually constructed, which index.ts does solely in fetchproxy mode.

import {
  createFetchproxyTransport,
  type BridgeProbeResult,
  type FetchproxyTransport as InnerTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import type { FetchResult, InsyncTransport, RequestOptions, S3Config } from './transport.js';

/**
 * The whole fetchproxy fleet shares this concentrator port — the ContextMint
 * Bridge extension dials this one port and servers host/peer-elect on it.
 */
export const DEFAULT_PORT = 37_149;

export interface FetchproxyTransportOptions {
  /** Practice subdomain, from INSYNC_PORTAL (e.g. `pfbhintouch`). */
  subdomain: string;
  version: string;
  port?: number;
  /** Injectable for tests; the real factory otherwise. */
  createInner?: typeof createFetchproxyTransport<InnerTransport>;
}

export class FetchproxyTransport implements InsyncTransport {
  private readonly inner: InnerTransport;

  constructor(opts: FetchproxyTransportOptions) {
    /* v8 ignore next */
    const factory = opts.createInner ?? createFetchproxyTransport;
    this.inner = factory({
      port: opts.port ?? DEFAULT_PORT,
      serverName: 'insync-mcp',
      version: opts.version,
      logListening: true,
      domains: ['insynchcs.com'],
      defaultSubdomain: opts.subdomain,
    });
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  status(): ReturnType<InnerTransport['status']> {
    return this.inner.status();
  }

  /** Run a healthcheck probe through the bridge (drives the bridge arm). */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string,
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }

  getS3Config(): S3Config | undefined {
    return undefined;
  }

  getJson(path: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.send('GET', path, undefined, { Accept: 'application/json' }, opts);
  }

  getText(path: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.send('GET', path, undefined, { Accept: 'text/html' }, opts);
  }

  postJson(path: string, body: unknown, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.send(
      'POST',
      path,
      JSON.stringify(body),
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      opts,
    );
  }

  postForm(
    path: string,
    form: Record<string, string> | URLSearchParams,
    opts: RequestOptions = {},
  ): Promise<FetchResult> {
    const body = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    return this.send(
      'POST',
      path,
      body,
      { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      opts,
    );
  }

  postText(path: string, body: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.send('POST', path, body, {}, opts);
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    baseHeaders: Record<string, string>,
    opts: RequestOptions,
  ): Promise<FetchResult> {
    const res = await this.inner.fetch({
      method,
      path: `/${path.replace(/^\/+/, '')}`,
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...baseHeaders, ...opts.headers },
      body,
    });
    return { status: res.status, body: res.body, url: res.url };
  }
}
