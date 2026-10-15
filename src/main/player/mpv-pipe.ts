import net from 'node:net';

export interface MpvMessage {
  event?: string;
  /** Set for property-change and cycle-property events. */
  name?: string;
  data?: any;
  /** end-file only: eof | stop | error | redirect. */
  reason?: string;
  error?: string;
  request_id?: number;
}

/**
 * The mpv JSON IPC pipe.
 *
 * mpv answers every command with `error:"success"` plus its `request_id`, and pushes events on the
 * same socket, so one line-buffered reader feeds both a reply table and an event callback. Replies
 * are correlated by id rather than by counting lines, which is what lets commands overlap.
 */
export class MpvPipe {
  private sock: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  onEvent: (m: MpvMessage) => void = () => undefined;
  onSocketClose: () => void = () => undefined;

  /** mpv only creates the pipe once it is running, so connecting is a retry loop with a deadline. */
  async connect(pipeName: string, timeoutMs = 10000): Promise<void> {
    const address = `\\\\.\\pipe\\${pipeName}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new Error('pipe client was closed');
      try {
        await this.attempt(address);
        return;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`mpv 的 IPC 管道始终没有打开：${pipeName}`);
        await new Promise(r => setTimeout(r, 120));
      }
    }
  }

  private attempt(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(address);
      const fail = (e: Error) => {
        sock.destroy();
        reject(e);
      };
      sock.once('connect', () => {
        sock.off('error', fail);
        this.sock = sock;
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', () => this.drop());
        sock.on('close', () => this.drop());
        resolve();
      });
      sock.once('error', () => fail(new Error('not listening yet')));
    });
  }

  /** A dead socket must not leave commands hanging on their own timeouts. */
  private drop(): void {
    this.sock = null;
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.forEach(p => p.reject(new Error('mpv 断开了连接')));
    this.pending.clear();
    this.onSocketClose();
  }

  /** One JSON object per line, but a chunk can split one or carry several. */
  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: MpvMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = msg.request_id;
      if (id != null && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.error && msg.error !== 'success') p.reject(new Error(`mpv ${msg.error}`));
        else p.resolve(msg.data);
        continue;
      }
      this.onEvent(msg);
    }
  }

  call<T = any>(command: unknown[], timeoutMs = 4000): Promise<T> {
    if (!this.sock?.writable) return Promise.reject(new Error('mpv 没有连接'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv 没有回应：${String(command[0])}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // The field is snake_case `request_id`; `async` keeps mpv from serialising behind a slow command.
      this.sock!.write(JSON.stringify({ command, async: true, request_id: id }) + '\n');
    });
  }

  /** A property we only read once, on the assumption that it may not exist yet. */
  async tryCall<T = any>(command: unknown[]): Promise<T | undefined> {
    try {
      return await this.call<T>(command, 2000);
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    this.sock?.destroy();
    this.sock = null;
  }
}
