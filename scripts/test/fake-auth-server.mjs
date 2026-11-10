// @ts-check
// A small in-memory stand-in for the Supabase Auth HTTP API, for tests that
// must run the app's real routes and the real auth-js / @supabase/ssr clients
// without a hosted project (src/lib/auth/linkFlow.test.ts, and a dry run of
// scripts/security/link-session-checks.mjs).
//
// It is a MODEL, not evidence: which `amr` method a verified e-mail link gets
// is this file's assumption (`linkAmr`, default "otp", what the Auth server's
// POST /verify is understood to record). Only the hosted check
// (scripts/security/link-session-runtime-test.mjs) can prove the real value.
//
// Implemented: POST /verify (token_hash), GET/PUT /user, POST /token
// (password, refresh_token), POST /logout, and the admin calls the hosted
// check uses (users create/list/delete, generate_link). Tokens are unsigned
// JWT-shaped strings; nothing here is a security boundary.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const b64 = (/** @type {unknown} */ o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * @param {{ linkAmr?: string | ((type: string) => string), now?: () => number, serviceKey?: string }} [options]
 */
export async function startFakeAuthServer(options = {}) {
  const now = options.now ?? (() => Date.now());
  const serviceKey = options.serviceKey ?? "fake-service-key";
  const linkAmr = options.linkAmr ?? "otp";
  /** @type {Map<string, { id: string, email: string, password: string | null, banned: boolean, confirmed: boolean, factors: { id: string, status: string, factor_type: string }[], created_at: string }>} */
  const users = new Map();
  /** @type {Map<string, { userId: string, type: string, used: boolean, expired: boolean }>} */
  const links = new Map();
  /** @type {Map<string, { id: string, userId: string, aal: string, amr: { method: string, timestamp: number }[], revoked: boolean, refresh: string }>} */
  const sessions = new Map();
  /** @type {{ method: string, path: string }[]} */
  const requests = [];
  /** Force the next answers of a path: { status, body }. @type {Map<string, { status: number, body: unknown }[]>} */
  const forced = new Map();

  const userJson = (/** @type {NonNullable<ReturnType<typeof users.get>>} */ u) => ({
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: u.confirmed ? u.created_at : null,
    confirmed_at: u.confirmed ? u.created_at : null,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    factors: u.factors,
    created_at: u.created_at,
    updated_at: u.created_at,
  });

  const accessToken = (/** @type {NonNullable<ReturnType<typeof sessions.get>>} */ s) => {
    const u = /** @type {NonNullable<ReturnType<typeof users.get>>} */ (users.get(s.userId));
    const iat = Math.floor(now() / 1000);
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", aal: s.aal, amr: s.amr, session_id: s.id, iat, exp: iat + 3600, jti: randomUUID() })}.fake-signature`;
  };
  const sessionJson = (/** @type {NonNullable<ReturnType<typeof sessions.get>>} */ s) => {
    const u = /** @type {NonNullable<ReturnType<typeof users.get>>} */ (users.get(s.userId));
    return { access_token: accessToken(s), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(now() / 1000) + 3600, refresh_token: s.refresh, user: userJson(u) };
  };
  const openSession = (/** @type {string} */ userId, /** @type {string} */ method, /** @type {number} */ at = now()) => {
    const s = { id: randomUUID(), userId, aal: "aal1", amr: [{ method, timestamp: Math.floor(at / 1000) }], revoked: false, refresh: randomUUID().replace(/-/g, "") };
    sessions.set(s.id, s);
    return s;
  };
  const sessionOf = (/** @type {import("node:http").IncomingMessage} */ req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    try {
      const claims = JSON.parse(Buffer.from(m[1].split(".")[1] ?? "", "base64url").toString("utf8"));
      const s = sessions.get(claims.session_id);
      return s && !s.revoked && users.has(s.userId) ? s : null;
    } catch {
      return null;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname.replace(/^\/auth\/v1/, "");
    requests.push({ method: req.method ?? "", path });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    /** @type {Record<string, unknown>} */
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { body = {}; }
    const send = (/** @type {number} */ status, /** @type {unknown} */ json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const fail = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ msg) => send(status, { code: status, error_code: code, msg });

    const queue = forced.get(`${req.method} ${path}`);
    const next = queue?.shift();
    if (next) return send(next.status, next.body);

    if (req.method === "POST" && path === "/verify") {
      const link = links.get(String(body.token_hash ?? ""));
      if (!link || link.used || link.expired || link.type !== body.type) return fail(403, "otp_expired", "Email link is invalid or has expired");
      const user = users.get(link.userId);
      if (!user) return fail(403, "otp_expired", "Email link is invalid or has expired");
      if (user.banned) return fail(403, "user_banned", "User is banned");
      link.used = true;
      user.confirmed = true;
      const method = typeof linkAmr === "function" ? linkAmr(link.type) : linkAmr;
      return send(200, sessionJson(openSession(user.id, method)));
    }
    if (req.method === "POST" && path === "/token" && url.searchParams.get("grant_type") === "password") {
      const user = [...users.values()].find((u) => u.email === body.email);
      if (!user || !user.password || user.password !== body.password) return fail(400, "invalid_credentials", "Invalid login credentials");
      if (user.banned) return fail(400, "user_banned", "User is banned");
      return send(200, sessionJson(openSession(user.id, "password")));
    }
    if (req.method === "POST" && path === "/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const s = [...sessions.values()].find((x) => x.refresh === body.refresh_token && !x.revoked);
      if (!s) return fail(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      s.refresh = randomUUID().replace(/-/g, "");
      return send(200, sessionJson(s));
    }
    if (path === "/user") {
      const s = sessionOf(req);
      if (!s) return fail(403, "session_not_found", "Session from session_id claim in JWT does not exist");
      const user = /** @type {NonNullable<ReturnType<typeof users.get>>} */ (users.get(s.userId));
      if (req.method === "GET") return send(200, userJson(user));
      if (req.method === "PUT") {
        if (typeof body.password === "string") {
          if (user.factors.some((f) => f.status === "verified") && s.aal !== "aal2") return fail(401, "insufficient_aal", "AAL2 session is required to update email or password when MFA is enabled.");
          if (body.password === user.password) return fail(422, "same_password", "New password should be different from the old password.");
          user.password = body.password;
        }
        return send(200, userJson(user));
      }
    }
    if (req.method === "POST" && path === "/logout") {
      const s = sessionOf(req);
      if (!s) return fail(403, "session_not_found", "Session not found");
      const scope = url.searchParams.get("scope") ?? "global";
      for (const other of sessions.values()) {
        if (other.userId !== s.userId) continue;
        if (scope === "global" || (scope === "local" && other.id === s.id) || (scope === "others" && other.id !== s.id)) other.revoked = true;
      }
      res.writeHead(204);
      return res.end();
    }

    if (path.startsWith("/admin/")) {
      if (req.headers.authorization !== `Bearer ${serviceKey}`) return fail(401, "no_authorization", "This endpoint requires a valid Bearer token");
      if (req.method === "POST" && path === "/admin/users") {
        if ([...users.values()].some((u) => u.email === body.email)) return fail(422, "email_exists", "A user with this email address has already been registered");
        const user = control.addUser({ email: String(body.email), password: typeof body.password === "string" ? body.password : null, confirmed: body.email_confirm === true });
        return send(200, userJson(user));
      }
      if (req.method === "GET" && path === "/admin/users") return send(200, { users: [...users.values()].map(userJson), aud: "authenticated" });
      const one = /^\/admin\/users\/([0-9a-f-]+)$/.exec(path);
      if (one && req.method === "DELETE") {
        if (!users.delete(one[1])) return fail(404, "user_not_found", "User not found");
        return send(200, {});
      }
      if (one && req.method === "GET") {
        const user = users.get(one[1]);
        return user ? send(200, userJson(user)) : fail(404, "user_not_found", "User not found");
      }
      if (req.method === "POST" && path === "/admin/generate_link") {
        const type = String(body.type);
        let user = [...users.values()].find((u) => u.email === body.email);
        if (type === "invite") {
          if (user) return fail(422, "email_exists", "A user with this email address has already been registered");
          user = control.addUser({ email: String(body.email), password: null, confirmed: false });
        }
        if (!user) return fail(404, "user_not_found", "User with this email not found");
        const hashed = control.issueLink(user.id, type);
        return send(200, { ...userJson(user), action_link: `http://fake/auth/v1/verify?token=${hashed}&type=${type}`, email_otp: "000000", hashed_token: hashed, verification_type: type, redirect_to: "" });
      }
    }
    return fail(404, "not_found", `fake auth server: no ${req.method} ${path}`);
  });

  const control = {
    serviceKey,
    anonKey: "fake-anon-key",
    url: "",
    requests,
    users,
    sessions,
    /** @param {{ email: string, password?: string | null, confirmed?: boolean, banned?: boolean, verifiedFactor?: boolean }} u */
    addUser(u) {
      const user = { id: randomUUID(), email: u.email, password: u.password ?? null, banned: u.banned ?? false, confirmed: u.confirmed ?? true, factors: u.verifiedFactor ? [{ id: randomUUID(), status: "verified", factor_type: "totp" }] : [], created_at: new Date(now()).toISOString() };
      users.set(user.id, user);
      return user;
    },
    /** A one-time e-mail link token for this user (what a template's {{ .TokenHash }} carries). */
    issueLink(/** @type {string} */ userId, /** @type {string} */ type) {
      const hashed = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      links.set(hashed, { userId, type, used: false, expired: false });
      return hashed;
    },
    expireLink(/** @type {string} */ hashed) {
      const link = links.get(hashed);
      if (link) link.expired = true;
    },
    linkUsed: (/** @type {string} */ hashed) => links.get(hashed)?.used === true,
    /** A session as the Auth server would have opened it `ageMs` ago with this amr method. */
    openSession(/** @type {string} */ userId, /** @type {string} */ method, ageMs = 0) {
      return sessionJson(openSession(userId, method, now() - ageMs));
    },
    /** Raise a session to aal2 the way a verified TOTP challenge does. */
    stepUp(/** @type {string} */ sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      s.aal = "aal2";
      s.amr.unshift({ method: "totp", timestamp: Math.floor(now() / 1000) });
      return sessionJson(s);
    },
    liveSessionsOf: (/** @type {string} */ userId) => [...sessions.values()].filter((s) => s.userId === userId && !s.revoked),
    /** Answer the next request to `METHOD /path` with this status and body. */
    forceNext(/** @type {string} */ route, /** @type {number} */ status, /** @type {unknown} */ body = { code: status, msg: "forced" }) {
      const queue = forced.get(route) ?? [];
      queue.push({ status, body });
      forced.set(route, queue);
    },
    count: (/** @type {string} */ method, /** @type {string} */ path) => requests.filter((r) => r.method === method && r.path === path).length,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  control.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return control;
}
