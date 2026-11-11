import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateIp, resolveWebhookTarget, type LookupFn } from "./webhookGuard";
import { postPinned, webhookSignature } from "./webhooks";
import { createHmac } from "node:crypto";

// A16: the webhook SSRF guard. Address checks (loopback, private, link-local
// and cloud metadata, IPv4-mapped/NAT64 tunnels, odd IPv4 spellings), the
// resolve-once rule (any private record blocks the name), and the pinned
// connection: the request goes to the vetted address without resolving the
// name again (no DNS-rebinding window), never follows a redirect, and gives up
// at the timeout.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const lookupOf = (answers: Record<string, string[]>): LookupFn => async (host) => {
  const a = answers[host];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

async function main() {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
    "fc00::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::1",
    "::127.0.0.1", "not-an-ip", "",
  ]) {
    check(`blocked: ${ip || "(empty)"}`, isPrivateIp(ip));
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    check(`allowed: ${ip}`, !isPrivateIp(ip));
  }

  const dns = lookupOf({
    "hooks.example.com": ["93.184.216.34"],
    "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
    "meta.example.com": ["169.254.169.254"],
    "v6.example.com": ["2606:4700:4700::1111"],
    "mapped.example.com": ["::ffff:127.0.0.1"],
  });
  const ok = await resolveWebhookTarget("https://hooks.example.com/in", dns);
  check("a public name resolves and is pinned", ok.ok && ok.ip === "93.184.216.34" && ok.family === 4);
  const v6 = await resolveWebhookTarget("https://v6.example.com/in", dns);
  check("a public IPv6 answer is pinned as v6", v6.ok && v6.family === 6);
  for (const [url, why] of [
    ["https://mixed.example.com/in", "any private record blocks the name"],
    ["https://meta.example.com/latest", "a name for the metadata IP"],
    ["https://mapped.example.com/", "an IPv4-mapped loopback answer"],
    ["https://unknown.example.com/", "an unresolvable name"],
    ["http://localhost:3000/", "localhost"],
    ["http://localhost./", "localhost with a trailing dot"],
    ["http://printer.local/", ".local"],
    ["http://db.internal/", ".internal"],
    ["http://127.0.0.1/", "loopback literal"],
    ["http://2130706433/", "decimal loopback"],
    ["http://0x7f.1/", "hex/short loopback"],
    ["http://[::ffff:127.0.0.1]/", "bracketed mapped loopback"],
    ["http://169.254.169.254/latest/meta-data", "metadata literal"],
    ["http://[fd00:ec2::254]/", "IPv6 metadata literal"],
  ] as const) {
    const r = await resolveWebhookTarget(url, dns);
    check(`blocked_url: ${why}`, !r.ok && r.reason === "blocked_url");
  }
  for (const url of ["ftp://hooks.example.com/", "https://user:pw@hooks.example.com/", "not a url", "javascript:alert(1)"]) {
    const r = await resolveWebhookTarget(url, dns);
    check(`invalid_url: ${url}`, !r.ok && r.reason === "invalid_url");
  }

  // --- the pinned connection, against a real local server ----------------------
  const hits: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let mode: "ok" | "redirect" | "hang" = "ok";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", headers: req.headers, body });
      if (mode === "hang") return; // never answer
      if (mode === "redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // "rebind.invalid" can't resolve at all: the request only works because the
  // connection uses the pinned address, never a second lookup.
  const target = { ok: true as const, url: new URL(`http://rebind.invalid:${port}/hook`), ip: "127.0.0.1", family: 4 as const };
  const body = JSON.stringify({ event: "prize_pending", prize: "Selfie" });
  const ts = 1_700_000_000;
  const sig = webhookSignature("s3cret", body, ts);
  check("the signature is HMAC-SHA256 over '<t>.<body>'", sig === `t=${ts},v1=${createHmac("sha256", "s3cret").update(`${ts}.${body}`).digest("hex")}`);
  const status = await postPinned(target, { "Content-Type": "application/json", "X-FanFunnel-Signature": sig }, body, 2000);
  check("delivered to the pinned address without resolving the name", status === 204 && hits.length === 1);
  check("the Host header still names the hook's host", hits[0].headers.host === `rebind.invalid:${port}`);
  check("the body and signature arrive intact", hits[0].body === body && hits[0].headers["x-fanfunnel-signature"] === sig);

  mode = "redirect";
  const redirected = await postPinned(target, {}, body, 2000);
  check("a redirect is reported, never followed", redirected === 302 && hits.length === 2);

  mode = "hang";
  const started = Date.now();
  const timedOut = await postPinned(target, {}, body, 300);
  check("a hanging endpoint is abandoned at the timeout", timedOut === 0 && Date.now() - started < 2000);

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  console.log(`webhookGuard.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
