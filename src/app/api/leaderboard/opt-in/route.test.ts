import assert from "node:assert";
import { POST } from "./route";
import { mockCreatePass, mockGetFanPass, mockSetLeaderboardEnabled, mockGetLeaderboard } from "@/lib/data/mock";

// The leaderboard opt-in is the fan's consent switch for a PUBLIC page, and fans
// are never authenticated — the only thing standing between a stranger and
// someone else's board presence is the fan link's token. These checks lock that
// gate: no token (or a token that resolves to no fan) must never flip a flag.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const post = (body: unknown, raw?: string) =>
  POST(
    new Request("http://localhost/api/leaderboard/opt-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    })
  );

async function main() {
  mockSetLeaderboardEnabled(true);
  const fan = mockCreatePass("Gated Gail", 2, undefined, undefined, 1500);
  // The route rate-limits per token (10/min, counting rejected requests too),
  // so each section below gets its own fan.
  const fanB = mockCreatePass("Nameless Nora", 2);
  const fanC = mockCreatePass("Quality Quinn", 2);
  const fanD = mockCreatePass("Boolean Bo", 2);

  // --- token gating -------------------------------------------------------
  check("a malformed body is rejected", (await post(undefined, "not json")).status === 400);
  check("a JSON null body is 400, not 500", (await post(undefined, "null")).status === 400);
  check("a JSON array body is 400", (await post([])).status === 400);
  check("a JSON string body is 400", (await post("token")).status === 400);
  check("a body with no token is rejected", (await post({ optIn: true })).status === 400);
  check("an empty token is rejected", (await post({ token: "", optIn: true })).status === 400);
  check(
    "a non-string token is rejected",
    (await post({ token: { $ne: null }, optIn: true })).status === 400
  );
  const unknown = await post({ token: "not-a-real-token-" + Date.now(), optIn: true, handle: "xx" });
  check("an unknown token is 404, not a silent success", unknown.status === 404);
  check(
    "a rejected request flips nothing",
    (await mockGetFanPass(fan.token))?.leaderboardOptIn === false
  );

  // --- a board name is mandatory to opt IN -------------------------------
  // Without one the only thing the board could show is the fan's real name,
  // which must never happen on a public page.
  for (const [label, body] of [
    ["no handle", { token: fanB.token, optIn: true }],
    ["empty handle", { token: fanB.token, optIn: true, handle: "" }],
    ["whitespace-only handle", { token: fanB.token, optIn: true, handle: "   " }],
  ] as const) {
    const res = await post(body);
    const json = (await res.json()) as { error?: string };
    check(`opt-in with ${label} is 400`, res.status === 400);
    check(`opt-in with ${label} says handle_required`, json.error === "handle_required");
  }
  // Handle quality: at least 2 chars with a letter or digit, and NEVER silently
  // mangled — if sanitising would change what the fan typed, say so instead.
  for (const [label, handle] of [
    ["a 1-char handle", "g"],
    ["a handle with no letter or digit", "._-"],
    ["a handle that sanitises to nothing", "<!>"],
    ["a handle with unsafe characters", "<script>gail</script>"],
    ["a handle with inner whitespace", "gail smith"],
    ["a handle with non-ASCII letters", "Ålïcé"],
    ["an over-long handle", "g".repeat(41)],
  ] as const) {
    const res = await post({ token: fanC.token, optIn: true, handle });
    const json = (await res.json()) as { error?: string };
    check(`opt-in with ${label} is 400`, res.status === 400);
    check(`opt-in with ${label} says handle_invalid`, json.error === "handle_invalid");
  }
  check(
    "a rejected handle flips nothing and stores nothing",
    (await mockGetFanPass(fanB.token))?.leaderboardOptIn === false &&
      (await mockGetFanPass(fanC.token))?.leaderboardOptIn === false &&
      !(await mockGetFanPass(fanB.token))?.fanHandle &&
      !(await mockGetFanPass(fanC.token))?.fanHandle
  );
  check(
    "opting OUT needs no handle",
    (await post({ token: fanC.token, optIn: false })).status === 200
  );

  // --- optIn must be a real boolean --------------------------------------
  // The string "false" is truthy; it must never read as consent.
  for (const bad of ["false", "true", 1, "yes", null, {}]) {
    const res = await post({ token: fanD.token, optIn: bad, handle: "gail" });
    check(`optIn=${JSON.stringify(bad)} is rejected with 400`, res.status === 400);
  }
  check(
    "a non-boolean optIn flips nothing",
    (await mockGetFanPass(fanD.token))?.leaderboardOptIn === false
  );

  // --- the happy path, with a real token ---------------------------------
  const ok = await post({ token: fan.token, optIn: true, handle: "gail" });
  check("a valid token opts the fan in", ok.status === 200);
  check(
    "the fan is now opted in",
    (await mockGetFanPass(fan.token))?.leaderboardOptIn === true
  );
  check(
    "and now appears on the public board",
    mockGetLeaderboard("demo-creator").entries.some((e) => e.handle === "gail")
  );

  // Surrounding whitespace is the one thing we trim silently; the stored handle
  // is otherwise exactly what the fan typed (and it passed the allow-list).
  check(
    "a padded but valid handle is accepted",
    (await post({ token: fan.token, optIn: true, handle: "  gail_2  " })).status === 200
  );
  const handle = (await mockGetFanPass(fan.token))?.fanHandle ?? "";
  check("the stored handle is the trimmed input", handle === "gail_2");

  // --- opting back out ----------------------------------------------------
  check("opting out succeeds", (await post({ token: fan.token, optIn: false })).status === 200);
  check(
    "the fan is off the public board again",
    !mockGetLeaderboard("demo-creator").entries.some((e) => e.handle === handle)
  );

  console.log(`leaderboard/opt-in route.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
