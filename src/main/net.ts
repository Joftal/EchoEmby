import { app, net, session } from 'electron';
import * as config from './config';
import { EmbyClient, type Identity } from './emby/client';
import { explain, setManualProxy } from './emby/errors';
import type { NetProbe, Settings } from '../shared/types';

/** Where the app's traffic actually goes. Every request this client makes - the Emby API, the poster
 *  URLs the renderer loads, the playback bridge mpv pulls from, and the outside metadata services -
 *  leaves through Chromium's network stack, so the session's proxy setting is the one switch for all
 *  of them; mpv itself never sees a proxy because it only ever opens a loopback URL. */
export interface ProxyRoute {
  rules: string;
  /** host:port with the credentials left off, for the sentence that tells the user the proxy is dead. */
  host: string;
  auth?: { username: string; password: string };
}

/** `127.0.0.1:7897`, `http://127.0.0.1:7897` and `http://user:pass@host:port` all describe one route.
 *  Chromium wants credentials out of the rules string and delivered by the login callback, so they are
 *  split here instead of being pasted through. */
export function parseProxy(raw: string): ProxyRoute | null {
  const s = (raw || '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const route: ProxyRoute = { rules: `${u.protocol}//${u.host}`, host: u.host };
  if (u.username) {
    try {
      route.auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch {
      return null;
    }
  }
  return route;
}

let current: ProxyRoute | null = null;
let loginHooked = false;

/** A hand-typed proxy is meant to reach outside, and Emby servers usually live inside: measured here,
 *  fixed_servers swallows 192.168.x.x (the request dies at the proxy) while 系统代理 answers it fine,
 *  because Windows ticks "bypass proxy for local addresses". So manual mode bypasses the ranges a
 *  server on the same network actually uses, or picking 手动代理 would break the library. */
const LOCAL_BYPASS = 'localhost,*.local,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,[::1]/128';

/** Chromium asks the proxy for credentials per request, and app's login hook only covers what the
 *  windows send: measured 2026-10-14 against a local proxy that demands Basic auth, a main-process
 *  request made before any renderer one came back 407 even though the address carried the password,
 *  and the identical request a moment later got through - the renderer's success had filled the
 *  session's proxy-auth cache. So a route that carries credentials authenticates itself once, through
 *  the ClientRequest API, which has its own login event. Any address will do: the proxy answers 407
 *  before it forwards anything. */
const PRIME_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

function primeProxyAuth(): void {
  const auth = current?.auth;
  if (!auth) return;
  const req = net.request({ method: 'GET', url: PRIME_URL });
  const timer = setTimeout(() => {
    try {
      req.abort();
    } catch {
      /* already finished */
    }
  }, 8000);
  req.on('login', (_info, callback) => callback(auth.username, auth.password));
  req.on('response', res => {
    res.on('data', () => undefined);
    res.on('end', () => clearTimeout(timer));
  });
  req.on('error', () => clearTimeout(timer));
  req.end();
}

/** Throws when the typed 手动代理 address cannot be parsed, so the page can say the route did not move.
 *  An empty address is not an error: the mode was picked before anything was typed, and the route that
 *  is already live stays live until there is something to point it at. */
export async function applyProxy(s: Settings): Promise<void> {
  let route: ProxyRoute | null = null;
  if (s.proxyMode === 'manual') {
    if (!s.proxyUrl.trim()) return;
    route = parseProxy(s.proxyUrl);
    if (!route) throw new Error('代理地址看不懂，例如 127.0.0.1:7897');
  }
  current = route;
  if (!loginHooked) {
    loginHooked = true;
    app.on('login', (e, _wc, _details, auth, callback) => {
      if (!auth.isProxy || !current?.auth) return;
      e.preventDefault();
      callback(current.auth.username, current.auth.password);
    });
  }
  const proxyConfig = s.proxyMode === 'none' ? { mode: 'direct' as const } : s.proxyMode === 'system' ? { mode: 'system' as const } : { mode: 'fixed_servers' as const, proxyRules: route!.rules, proxyBypassRules: LOCAL_BYPASS };
  await session.defaultSession.setProxy(proxyConfig);
  // Only once the route actually moved: an address that threw above must leave the old route's name on
  // the timeout sentence, or the page would blame a proxy that is not in use.
  setManualProxy(s.proxyMode === 'manual' ? route!.host : '');
  primeProxyAuth();
}

/** Cloudflare's trace answers in ~40 bytes with the address it saw and the country it saw it from, which
 *  is what tells the modes apart: measured here it says JP through the local proxy and CN direct. A
 *  Chinese echo cannot - myip.ipip.net answers the CN address even through the proxy, because those
 *  rules send CN domains direct. */
async function readEgress(): Promise<{ ip: string; region: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: ctrl.signal, headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error(`出口检测服务返回 HTTP ${res.status}`);
    const text = await res.text();
    const ip = /(?:^|\n)ip=(\S+)/.exec(text)?.[1] || '';
    if (!ip) throw new Error('出口检测服务没有给出地址');
    return { ip, region: /(?:^|\n)loc=(\S+)/.exec(text)?.[1] || '' };
  } finally {
    clearTimeout(timer);
  }
}

const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number | null; data: T | null; error: string }> => {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { ms: Date.now() - t0, data, error: '' };
  } catch (e) {
    return { ms: null, data: null, error: explain(e) };
  }
};

/** Both legs run at once and each reports for itself: the interesting answer is the pair (does the
 *  server still answer, and whose address do we leave from), not a single pass/fail. */
export async function probeNetwork(identity: Identity): Promise<NetProbe> {
  const acc = config.activeAccount();
  const [server, egress] = await Promise.all([
    acc ? timed(() => EmbyClient.publicInfo(acc.baseUrl, identity)) : Promise.resolve(null),
    timed(readEgress),
  ]);
  const errors: string[] = [];
  if (server?.error) errors.push(`服务器：${server.error}`);
  if (egress.error) errors.push(`出口：${egress.error}`);
  return {
    serverMs: server?.ms ?? null,
    egressIp: egress.data?.ip || '',
    egressRegion: egress.data?.region || '',
    error: errors.join('；'),
  };
}
