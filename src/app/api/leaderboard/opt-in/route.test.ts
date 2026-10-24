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

  // --- token gating -------------------------------------------------------
  check("a malformed body is rejected", (await post(undefined, "not json")).status === 400);
  check("a body with no token is rejected", (await post({ optIn: true })).status === 400);
  check("an empty token is rejected", (await post({ token: "", optIn: true })).status === 400);
  check(
    "a non-string token is rejected",
    (await post({ token: { $ne: null }, optIn: true })).status === 400
  );
  const unknown = await post({ token: "not-a-real-token-" + Date.now(), optIn: true });
  check("an unknown token is 404, not a silent success", unknown.status === 404);
  check(
    "a rejected request flips nothing",
    (await mockGetFanPass(fan.token))?.leaderboardOptIn === false
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

  // The handle is sanitized server-side (it is rendered on a public page).
  await post({ token: fan.token, optIn: true, handle: "  <script>x</script> gail!  " });
  const handle = (await mockGetFanPass(fan.token))?.fanHandle ?? "";
  check("the stored handle is stripped of unsafe characters", !/[<>!\s]/.test(handle));

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
