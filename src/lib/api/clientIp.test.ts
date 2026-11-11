import assert from "node:assert";
import { clientIp } from "./clientIp";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const req = (headers: Record<string, string>) =>
  new Request("https://x.test/api/spin", { headers });

// --- Platform headers (set by Vercel's edge) win over x-forwarded-for --------
check(
  "x-real-ip preferred over x-forwarded-for",
  clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" })) === "9.9.9.9",
);
check(
  "x-vercel-forwarded-for preferred over x-forwarded-for",
  clientIp(req({ "x-vercel-forwarded-for": "7.7.7.7", "x-forwarded-for": "1.2.3.4" })) ===
    "7.7.7.7",
);
check(
  "x-real-ip preferred over x-vercel-forwarded-for",
  clientIp(req({ "x-vercel-forwarded-for": "7.7.7.7", "x-real-ip": "9.9.9.9" })) === "9.9.9.9",
);
{
  // Behind a proxy that pins x-real-ip/XFF but passes other headers through,
  // rotating x-vercel-forwarded-for must not mint a fresh bucket per request.
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((s) =>
      clientIp(
        req({ "x-vercel-forwarded-for": s, "x-real-ip": "9.9.9.9", "x-forwarded-for": "9.9.9.9" }),
      ),
    ),
  );
  check("rotating x-vercel-forwarded-for under a pinned x-real-ip yields one bucket", keys.size === 1);
}

// The attack: the client prepends its own entry to x-forwarded-for, rotating it
// per request to land in a fresh rate-limit bucket each time.
for (const spoof of ["1.2.3.4", "10.0.0.1", "local", "::1"]) {
  check(
    `spoofed XFF "${spoof}, <real>" loses to x-real-ip`,
    clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": `${spoof}, 9.9.9.9` })) ===
      "9.9.9.9",
  );
  check(
    `spoofed XFF "${spoof}, <real>" loses to x-vercel-forwarded-for`,
    clientIp(
      req({ "x-vercel-forwarded-for": "7.7.7.7", "x-forwarded-for": `${spoof}, 7.7.7.7` }),
    ) === "7.7.7.7",
  );
}
{
  // Rotating the spoofed entry must not change the key.
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((s) =>
      clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": `${s}, 9.9.9.9` })),
    ),
  );
  check("rotating a spoofed XFF entry yields one bucket", keys.size === 1);
}

// cf-connecting-ip is not set by Vercel, so on this deployment it is just a
// client-supplied header. It must never be trusted.
check(
  "cf-connecting-ip ignored when a platform header exists",
  clientIp(req({ "cf-connecting-ip": "8.8.8.8", "x-real-ip": "9.9.9.9" })) === "9.9.9.9",
);
check(
  "cf-connecting-ip ignored when only XFF exists",
  clientIp(req({ "cf-connecting-ip": "8.8.8.8", "x-forwarded-for": "5.6.7.8" })) === "5.6.7.8",
);
check("cf-connecting-ip alone is ignored", clientIp(req({ "cf-connecting-ip": "8.8.8.8" })) === "local");

// --- Local / unproxied fallback ----------------------------------------------
// No platform header: use the RIGHT-most XFF hop (the one the nearest proxy, or
// Next's own server from the socket address, wrote), never the client's left-most.
check(
  "XFF-only: left-most (client) entry does not win",
  clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })) === "5.6.7.8",
);
check(
  "XFF-only: entries are trimmed",
  clientIp(req({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8 " })) === "5.6.7.8",
);
check("XFF single entry (local next start)", clientIp(req({ "x-forwarded-for": "::1" })) === "::1");
check(
  "XFF trailing empty entries are skipped",
  clientIp(req({ "x-forwarded-for": "5.6.7.8, ," })) === "5.6.7.8",
);

// No usable header -> stable sentinel (never throws).
check("no headers -> local", clientIp(req({})) === "local");
check("empty XFF -> local", clientIp(req({ "x-forwarded-for": "" })) === "local");
check("comma-only XFF -> local", clientIp(req({ "x-forwarded-for": " , , " })) === "local");
check(
  "blank platform headers fall through",
  clientIp(req({ "x-vercel-forwarded-for": " ", "x-real-ip": "   ", "x-forwarded-for": "5.6.7.8" })) ===
    "5.6.7.8",
);
check(
  "blank x-vercel-forwarded-for falls through to x-real-ip",
  clientIp(req({ "x-vercel-forwarded-for": "", "x-real-ip": "9.9.9.9" })) === "9.9.9.9",
);
check(
  "platform header list takes its first entry",
  clientIp(req({ "x-vercel-forwarded-for": "7.7.7.7, 10.0.0.1" })) === "7.7.7.7",
);

console.log(`clientIp.test: ${passed} checks passed`);
