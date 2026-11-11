import assert from "node:assert/strict";
import { mock } from "node:test";
import * as React from "react";

// Execute the real rescue panel and shared privacy components. Hook storage
// models keyed identity, while actual handlers build and validate the request.
type Host = { slots: unknown[]; cursor: number };
const host = (): Host => ({ slots: [], cursor: 0 });
let current: Host;
function slot<T>(initial: () => T) {
  const owner = current, index = owner.cursor++;
  if (!(index in owner.slots)) owner.slots[index] = initial();
  return { owner, index, value: owner.slots[index] as T };
}
let pathname: string | null = "/spin/paused-token";
let publicReads = 0;
mock.module("react", { namedExports: { ...React,
  useState: (initial: unknown) => {
    const state = slot(() => typeof initial === "function" ? initial() : initial);
    return [state.value, (next: unknown) => {
      state.owner.slots[state.index] = typeof next === "function" ? next(state.owner.slots[state.index]) : next;
    }];
  },
  useRef: (value: unknown) => slot(() => ({ current: value })).value,
  useId: () => "rescue-panel",
  useEffect: () => {},
} });
mock.module("next/navigation", { namedExports: { usePathname: () => pathname } });
mock.module("@/lib/hooks/useFetch", { namedExports: { useFetch: () => { publicReads++; throw new Error("Rescue must not fetch competitive data"); } } });
type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function run<T>(owner: Host, render: () => T): T { current = owner; owner.cursor = 0; return render(); }
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { default: LinkDataRescue } = await import("./LinkDataRescue");
  const { LeaderboardWithdrawal } = await import("./FanLeaderboard");
  const { FanDataActions } = await import("./FanDataControls");
  const requests: { url: string; init?: RequestInit; body: unknown }[] = [];
  let success = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(success ? { ok: true } : { error: "not_found" }), { status: success ? 200 : 404 });
  };
  try {
    const parentHost = host(); let withdrawalHost = host(), withdrawalKey: string | null | undefined;
    let nodes: Element[] = [], childNodes: Element[] = [];
    const render = () => {
      nodes = elements(run(parentHost, () => LinkDataRescue()));
      const actions = nodes.find(node => node.type === FanDataActions);
      if (actions) run(host(), () => FanDataActions(actions.props as Parameters<typeof FanDataActions>[0]));
      const child = nodes.find(node => node.type === LeaderboardWithdrawal);
      if (child) {
        if (child.key !== withdrawalKey) { withdrawalHost = host(); withdrawalKey = child.key; }
        childNodes = elements(run(withdrawalHost, () => LeaderboardWithdrawal(child.props as Parameters<typeof LeaderboardWithdrawal>[0])));
      } else { childNodes = []; withdrawalKey = undefined; }
      return nodes;
    };
    const toggle = () => {
      const button = nodes.find(node => node.type === "button" && Object.hasOwn(node.props, "aria-expanded")); assert.ok(button); return button;
    };
    const withdrawButton = () => {
      const button = childNodes.find(node => node.props["data-testid"] === "leaderboard-withdraw"); assert.ok(button); return button;
    };
    render();
    check("404 rescue mounts closed without consent or public-data requests", requests.length === 0 && publicReads === 0 && childNodes.length === 0);
    check("existing download/delete discovery label remains unchanged", toggle().props.children === "Was this your link? Download or delete your data");
    check("withdrawal is discoverable without exposing any fan state", JSON.stringify(nodes.map(node => node.props.children)).includes("You can also remove yourself from the leaderboard here."));
    (toggle().props.onClick as () => void)(); render();
    check("explicitly opened rescue includes existing data actions and shared withdrawal", nodes.some(node => node.type === FanDataActions) && nodes.some(node => node.type === LeaderboardWithdrawal));
    check("opening rescue still performs no automatic I/O", requests.length === 0 && publicReads === 0);
    check("withdrawal has no join, ranking, name or reactivation invitation", !/Keep spinning|Top spinners|Board name|Join|Reactivate/.test(JSON.stringify(childNodes.map(node => node.props.children)))
      && !childNodes.some(node => node.type === "input" || node.props.role === "switch"));
    (withdrawButton().props.onClick as () => void)(); await settle(); render();
    check("paused-link explicit removal sends only token and false to existing route", requests.length === 1
      && requests[0].url === "/api/leaderboard/opt-in" && JSON.stringify(requests[0].body) === JSON.stringify({ token: "paused-token", optIn: false })
      && requests[0].init?.method === "POST" && requests[0].init.cache === "no-store");
    check("confirmed removal reports success without navigating or reactivating link", JSON.stringify(childNodes.map(node => node.props.children)).includes("You're off the leaderboard.")
      && pathname === "/spin/paused-token" && publicReads === 0);
    const firstKey = withdrawalKey;
    pathname = "/spin/other%5Ftoken"; render();
    check("token identity changes reset private result state", withdrawalKey !== firstKey && withdrawButton().props.disabled === false
      && !JSON.stringify(childNodes.map(node => node.props.children)).includes("You're off the leaderboard."));
    check("path identity change performs no automatic request", requests.length === 1 && publicReads === 0);
    (withdrawButton().props.onClick as () => void)(); await settle(); render();
    check("new explicit action uses only the decoded current token", requests.length === 2
      && JSON.stringify(requests[1].body) === JSON.stringify({ token: "other_token", optIn: false }));
    pathname = "/spin/unknown-token"; success = false; render();
    (withdrawButton().props.onClick as () => void)(); await settle(); render();
    check("unknown token keeps a generic retryable failure without fan enumeration", childNodes.some(node => node.props.role === "alert")
      && JSON.stringify(childNodes.map(node => node.props.children)).includes("Couldn't remove you from the leaderboard. Try again.")
      && !JSON.stringify(childNodes.map(node => node.props.children)).includes("not_found") && withdrawButton().props.disabled === false);
    (toggle().props.onClick as () => void)(); render();
    check("closing unmounts the private action without another write", childNodes.length === 0 && requests.length === 3);
    for (const path of [null, "/dashboard", "/spin/", "/spin/%E0%A4%A", "/spin/%"]) {
      pathname = path;
      check("missing or malformed pathname does not crash or expose a control", run(host(), () => LinkDataRescue()) === null && requests.length === 3 && publicReads === 0);
    }
    check("every rescue request is false-only and contains no handle or other fan field", requests.every(request => {
      const body = request.body as Record<string, unknown>;
      return body.optIn === false && Object.keys(body).sort().join(",") === "optIn,token";
    }));
  } finally { globalThis.fetch = originalFetch; }
  console.log(`LinkDataRescue: ${passed} actual rescue/shared-control lifecycle and no-I/O checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
