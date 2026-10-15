import { EmbyError } from './client';

const CJK = /[一-鿿]/;

// Renderer-facing copy for a failure. Everything the user can see crosses ipc.ts's wrap(), so
// this is the one place that turns Chromium's net:: codes, Node's errno names and Emby's own
// English bodies into a sentence that says which layer broke.
const NET: Array<[RegExp, string]> = [
  [/err_name_not_resolved|enotfound|eai_again|no such host/, '地址解析不了，检查域名有没有写错'],
  // Chromium reports a dead manual proxy with the same err_proxy code as a dead system proxy, so
  // the sentence must not name one of them or it sends the user to the wrong settings row.
  [/err_proxy|err_socks|proxy connection/, '代理连不上，检查代理有没有开着、地址和端口有没有写错'],
  [/err_connection_refused|econnrefused/, '这个端口拒绝连接，检查地址和端口'],
  [/err_connection_reset|err_connection_aborted|err_empty_response|econnreset|epipe/, '连接被中断，多半是代理或网关断的'],
  [/err_cert|err_bad_ssl|self[- ]signed|unable to verify|certificate/, '证书没被系统信任'],
  // A failed handshake means the port is not TLS or the scheme is wrong, which is a far more
  // common mistake than a bad certificate; merging them would send the user to install a root cert.
  [/err_ssl_protocol|err_ssl_version|err_ssl_invalid_message|handshake|wrong version number|unsupportedprotocol|tls/, '加密连接谈不成，检查 http 与 https 有没有写反'],
  [/err_address_unreachable|enetunreach|err_network_changed/, '网络到不了这台服务器'],
  [/err_timed_out|err_timeout|etimedout|timed? ?out|abort|network ?error|fetch failed|err_failed/, '等不到服务器回应，超时了'],
  [/invalid url|invalid uri/, '地址格式不对，例如 https://host:8096'],
  [/unexpected .*(json|<)|not valid json|json\.parse/, '服务器的回应看不懂，确认地址指向的是 Emby'],
];

// Electron sometimes leaves the real reason only in `cause`, so match the whole chain.
const chainText = (e: unknown): string => {
  let out = '';
  for (let c: any = e; c && out.length < 600; c = c.cause) out += ` ${String(c?.message ?? c)}`;
  return out.toLowerCase();
};

/** The address 手动代理 is live on, written by net.ts whenever the route moves. Empty for 系统代理 and
 *  不代理, so the sentence below only appears when the user actually pointed the app at a proxy. */
let manualProxy = '';
export function setManualProxy(host: string): void {
  manualProxy = host;
}

const TIMEOUT = /err_timed_out|err_timeout|etimedout|abort/;

const classifyNet = (key: string): string | undefined => {
  // Measured 2026-10-14 against a closed port: a hand-typed proxy that is not there does not always say
  // so - an http:// address dies as err_proxy, which the table already calls a proxy, but a socks5:// one
  // hangs until our own timeout aborts it. Left as a plain server timeout it sends the user to wait on a
  // route that will never answer; a slow server behind a working proxy hangs the same way, so both stay
  // in the sentence.
  if (manualProxy && TIMEOUT.test(key)) return `等不到回应，超时了，检查手动代理 ${manualProxy} 有没有在工作，或过一会儿再试`;
  return NET.find(([re]) => re.test(key))?.[1];
};

const redact = (s: string): string => s.replace(/([?&]api_key=)[^&\s]+/gi, '$1<redacted>');

/** mpv's own JSON IPC replies, which cross here when a control is refused. None of them is a network
 *  event, and the fall-through sentence below would blame the gateway for what is a bad property name,
 *  sending the user to check a route that answered fine. Measured against the bundled 0.41 build. */
const MPV: Array<[RegExp, string]> = [
  [/property not found/, '播放器没有这个设置项'],
  [/unsupported format for accessing property/, '这个设置的值格式不对，播放器没有接受'],
  [/invalid argument|invalid parameter/, '播放器认为这个参数不对'],
  [/option not found/, '播放器的启动参数里没有这一项'],
  [/mpv 没有回应/, '播放器没有回答，可能已经卡住了'],
];

export function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  // Our own throws are already Chinese; translating them twice would lose the exact wording.
  if (CJK.test(raw)) return redact(raw);
  if (/^mpv /.test(raw)) return MPV.find(([re]) => re.test(raw))?.[1] || '播放器拒绝了这个操作，详细信息在主进程日志里';
  const status = e instanceof EmbyError ? e.status : 0;
  // A status the server actually sent outranks the wording of its body; no status means the
  // request never got an answer, which must never be reported as a bad password.
  if (status < 400) {
    const net = classifyNet(chainText(e));
    if (net) return net;
  }
  if (status === 401 || status === 403) return '账号或密码不对，或者登录已经过期';
  // Only a proxy answers 407 - the server itself asks for credentials with 401 - so this names the
  // 手动代理 address rather than the account. Measured against a local proxy that demands Basic auth.
  if (status === 407) return '代理要求登录，代理地址写成 user:pass@host:port 再试';
  if (status === 404) return '服务器上找不到这个条目';
  if (status === 429) return '请求太频繁，过一会儿再试';
  // Measured 2026-10-12: with the system proxy on, a host that cannot be resolved comes back as
  // 502 from the proxy rather than as a DNS error, so the address itself is a candidate here and
  // blaming only the origin would send the user to wait on a typo they made.
  if (status === 502 || status === 504) return `没能连上服务器（HTTP ${status}），检查地址有没有写错，或过一会儿再试`;
  if (status >= 500) return `服务器出错了（HTTP ${status}），过一会儿再试`;
  if (status >= 400) return `服务器拒绝了这个请求（HTTP ${status}）`;
  // Nothing in the table matched and the server never sent a status, so the request died in
  // transit. detail() keeps the raw English in the log; pasting it here would put English on screen.
  return '连不上这台服务器，检查地址是否可用';
}

/** Kept for the log: the mapped sentence hides what actually happened from whoever debugs it. */
export function detail(e: unknown): string {
  let out = '';
  for (let c: any = e; c; c = c.cause) {
    out += ` | ${c?.name ?? ''}: ${String(c?.message ?? c)}`;
    if (out.length > 500 || c.cause === c) break;
  }
  return redact(out.replace(/^ \| /, ''));
}
