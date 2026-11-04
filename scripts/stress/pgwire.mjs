// Minimal PostgreSQL simple-query client (no dependency) for the stress harness.
// Speaks protocol 3.0 over a unix socket with trust auth, which is all the
// disposable local cluster needs. A pool of persistent sessions stands in for
// a connection pooler, so hundreds of concurrent callers contend on real row
// locks instead of on psql process spawns. Results mimic `psql -qAt`: rows
// joined by newlines, columns by tabs, nulls empty. Never used against a
// hosted project: it only knows how to dial a socket path.
import { connect } from "node:net";

const enc = new TextEncoder(), dec = new TextDecoder();

export class PgError extends Error {
  constructor(fields) { super(fields.M ?? "postgres error"); this.code = fields.C ?? null; this.detail = fields.D ?? null; this.fields = fields; }
}

function parseFields(buf) {
  const out = {}; let at = 0;
  while (at < buf.length && buf[at] !== 0) {
    const type = String.fromCharCode(buf[at]); const end = buf.indexOf(0, at + 1);
    out[type] = dec.decode(buf.subarray(at + 1, end)); at = end + 1;
  }
  return out;
}

export class PgSession {
  constructor(socketDir, port, user = "postgres", database = "postgres") {
    this.path = `${socketDir}/.s.PGSQL.${port}`; this.user = user; this.database = database;
    this.buf = Buffer.alloc(0); this.sock = null; this.waiter = null; this.ready = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = connect(this.path); this.sock = sock;
      sock.on("error", e => { if (this.waiter) this.waiter.reject(e); else reject(e); });
      sock.on("close", () => { if (this.waiter) this.waiter.reject(Error("postgres session closed")); });
      sock.on("data", chunk => this.onData(chunk));
      sock.once("connect", () => {
        const params = `user\0${this.user}\0database\0${this.database}\0\0`;
        const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), Buffer.from(params, "utf8")]);
        const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
        this.waiter = { resolve, reject, rows: [], fields: null, error: null, startup: true };
        sock.write(Buffer.concat([len, body]));
      });
    });
  }
  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 5) return;
      const len = this.buf.readInt32BE(1); if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]), body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      this.onMessage(type, body);
    }
  }
  onMessage(type, body) {
    const w = this.waiter; if (!w) return;
    if (type === "R") { if (body.readInt32BE(0) !== 0) w.reject(Error("unexpected authentication request (trust expected)")); return; }
    if (type === "T") { w.fields = []; let at = 2; const n = body.readInt16BE(0); for (let i = 0; i < n; i++) { const end = body.indexOf(0, at); w.fields.push(dec.decode(body.subarray(at, end))); at = end + 1 + 18; } return; }
    if (type === "D") { const n = body.readInt16BE(0); let at = 2; const row = []; for (let i = 0; i < n; i++) { const l = body.readInt32BE(at); at += 4; if (l === -1) { row.push(null); } else { row.push(dec.decode(body.subarray(at, at + l))); at += l; } } w.rows.push(row); return; }
    if (type === "E") { w.error = new PgError(parseFields(body)); return; }
    if (type === "Z") {
      const status = String.fromCharCode(body[0]); this.waiter = null;
      if (w.startup) { this.ready = true; w.resolve(this); return; }
      w.resolve({ rows: w.rows, fields: w.fields, error: w.error, status });
      return;
    }
    // S ParameterStatus, K BackendKeyData, C CommandComplete, N Notice, I EmptyQuery: nothing to keep.
  }
  /** Run a simple query string (several statements allowed). Resolves to psql -qAt text; rejects with PgError. */
  async query(text) {
    if (this.waiter) throw Error("session busy");
    const result = await new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, rows: [], fields: null, error: null, startup: false };
      const body = enc.encode(text + "\0"); const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
      this.sock.write(Buffer.concat([Buffer.from("Q"), len, Buffer.from(body)]));
    });
    if (result.status !== "I") await this.reset();
    if (result.error) throw result.error;
    return result.rows.map(r => r.map(c => c ?? "").join("\t")).join("\n");
  }
  reset() { return new Promise((resolve, reject) => { this.waiter = { resolve, reject, rows: [], fields: null, error: null, startup: false }; const body = enc.encode("rollback\0"); const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4); this.sock.write(Buffer.concat([Buffer.from("Q"), len, Buffer.from(body)])); }); }
  close() { this.sock?.destroy(); }
}

/** A fixed-size pool: `sql(text)` waits for a free session, like a pooler would. */
export async function createPool(socketDir, port, size = 32) {
  const sessions = []; for (let i = 0; i < size; i++) sessions.push(await new PgSession(socketDir, port).connect());
  const idle = [...sessions], queue = []; let inflight = 0, peakQueue = 0;
  const take = () => new Promise(resolve => { const s = idle.pop(); if (s) resolve(s); else { queue.push(resolve); peakQueue = Math.max(peakQueue, queue.length); } });
  const give = s => { const next = queue.shift(); if (next) next(s); else idle.push(s); };
  const sql = async text => { const s = await take(); inflight++; try { return await s.query(text); } finally { inflight--; give(s); } };
  return { sql, size, stats: () => ({ inflight, queued: queue.length, peakQueue }), close: () => sessions.forEach(s => s.close()) };
}
