import assert from "node:assert";
import {
  AUTH_REDIRECT_COOLDOWN_MS,
  LoadError,
  RATE_LIMITED_MESSAGE,
  SIGNED_OUT_MESSAGE,
  loadErrorMessage,
  loadJson,
  loginRedirectHref,
  redirectToLogin,
  resetAuthRedirect,
  type RedirectEnv,
} from "./loadJson";

const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

async function failure(status: number, opts: { authRedirect?: boolean } = {}) {
  let redirected = 0;
  try {
    await loadJson("/api/fans", { fetchImpl: answer(status), redirect: () => { redirected++; }, ...opts });
  } catch (e) {
    return { error: e, redirected };
  }
  throw new Error(`status ${status} did not throw`);
}

(async () => {
  // Success: the body, untouched.
  assert.deepEqual(await loadJson("/api/fans", { fetchImpl: answer(200, { fans: [] }) }), { fans: [] });

  // 401: an auth failure, the signed-out message, and one redirect to sign in.
  const unauth = await failure(401);
  assert.ok(unauth.error instanceof LoadError && unauth.error.kind === "auth" && unauth.error.status === 401);
  assert.equal(loadErrorMessage(unauth.error, "your fans"), SIGNED_OUT_MESSAGE);
  assert.equal(unauth.redirected, 1, "a 401 asks to redirect");
  assert.equal((await failure(401, { authRedirect: false })).redirected, 0, "fan pages opt out of the redirect");

  // 429: rate-limited copy, no redirect.
  const limited = await failure(429);
  assert.ok(limited.error instanceof LoadError && limited.error.kind === "rate");
  assert.equal(loadErrorMessage(limited.error, "your fans"), RATE_LIMITED_MESSAGE);
  assert.equal(RATE_LIMITED_MESSAGE, "Too many requests, try again in a moment.");
  assert.equal(limited.redirected, 0);

  // 500 / 403 / 404: "Couldn't load …", never an empty list.
  for (const status of [500, 502, 403, 404]) {
    const f = await failure(status);
    assert.ok(f.error instanceof LoadError && f.error.kind === "server", `${status} is a server failure`);
    assert.equal(loadErrorMessage(f.error, "your fans"), "Couldn't load your fans.");
    assert.equal(f.redirected, 0);
  }

  // Network failure and a non-JSON body.
  const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  await assert.rejects(loadJson("/x", { fetchImpl: offline }), (e: unknown) => e instanceof LoadError && e.kind === "network");
  const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(loadJson("/x", { fetchImpl: html }), (e: unknown) => e instanceof LoadError && e.kind === "server");
  assert.equal(loadErrorMessage(new Error("x"), "the inbox"), "Couldn't load the inbox.");

  // The return path keeps the section.
  assert.equal(loginRedirectHref({ pathname: "/dashboard", search: "?section=fans" }), "/login?next=%2Fdashboard%3Fsection%3Dfans");

  // Redirect once per page, and not again within the cooldown (no loop).
  const store = new Map<string, string>();
  let t = 1_000_000;
  const assigned: string[] = [];
  const env: RedirectEnv = {
    location: { pathname: "/dashboard", search: "?section=inbox", assign: (h) => { assigned.push(h); } },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    now: () => t,
  };
  resetAuthRedirect();
  assert.equal(redirectToLogin(env), true);
  assert.deepEqual(assigned, ["/login?next=%2Fdashboard%3Fsection%3Dinbox"]);
  assert.equal(redirectToLogin(env), false, "a second 401 on the same page does not redirect again");
  resetAuthRedirect(); // a new page load after signing in again
  t += 5_000;
  assert.equal(redirectToLogin(env), false, "a 401 straight after coming back does not loop to /login");
  t += AUTH_REDIRECT_COOLDOWN_MS;
  assert.equal(redirectToLogin(env), true, "after the cooldown a new sign-out redirects again");
  assert.equal(assigned.length, 2);
  resetAuthRedirect();
  assert.equal(redirectToLogin({ ...env, location: { ...env.location, pathname: "/login" } }), false, "never from /login itself");
  resetAuthRedirect();
  assert.equal(redirectToLogin({ ...env, storage: null, now: () => t + 10 * AUTH_REDIRECT_COOLDOWN_MS }), true, "no storage still redirects once");
  console.log("loadJson: all checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
