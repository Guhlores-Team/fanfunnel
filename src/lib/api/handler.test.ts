import assert from "node:assert";
import { BAD_REQUEST, JSON_BODY_MAX_BYTES, isJsonObject, parseJsonBody } from "./handler";

// parseJsonBody is the one JSON entry point of every route: a malformed or
// missing body is BAD_REQUEST, and so is a body over JSON_BODY_MAX_BYTES,
// refused on its declared Content-Length or while streaming, never parsed.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://x.test/api/spin", { method: "POST", body, headers });

async function main() {
  const small = await parseJsonBody<{ token: string }>(post(JSON.stringify({ token: "t" }), { "content-type": "application/json" }));
  check("a small JSON body is parsed", small !== BAD_REQUEST && small.token === "t");
  check("a malformed body is BAD_REQUEST", (await parseJsonBody(post("{not json"))) === BAD_REQUEST);
  check("an empty body is BAD_REQUEST", (await parseJsonBody(post(null))) === BAD_REQUEST);

  // L4: valid JSON that is not an object never reaches a route's body.x.
  for (const raw of ["null", "[]", '[{"token":"t"}]', "1", "0", '"token"', "true", "false", " null "]) {
    check(`a ${raw.trim()} body is BAD_REQUEST`, (await parseJsonBody(post(raw))) === BAD_REQUEST);
  }
  const empty = await parseJsonBody(post("{}"));
  check("an empty object is parsed", empty !== BAD_REQUEST && Object.keys(empty).length === 0);
  const allowed = await parseJsonBody(post(null), { allowEmpty: true });
  check("allowEmpty reads an empty body as {}", allowed !== BAD_REQUEST && Object.keys(allowed).length === 0);
  check("allowEmpty still refuses null", (await parseJsonBody(post("null"), { allowEmpty: true })) === BAD_REQUEST);
  check("allowEmpty still refuses malformed JSON", (await parseJsonBody(post("{x"), { allowEmpty: true })) === BAD_REQUEST);
  check("isJsonObject: objects only", isJsonObject({}) && !isJsonObject(null) && !isJsonObject([]) && !isJsonObject("x") && !isJsonObject(1));

  const declared = post("{}", { "content-length": String(JSON_BODY_MAX_BYTES + 1) });
  check("a declared Content-Length over the cap is refused up front", (await parseJsonBody(declared)) === BAD_REQUEST);

  const big = `{"name":"${"x".repeat(JSON_BODY_MAX_BYTES + 16)}"}`;
  let parsed = false;
  const original = JSON.parse;
  JSON.parse = ((text: string) => { parsed = true; return original(text); }) as typeof JSON.parse;
  try {
    check("a streamed body over the cap is refused", (await parseJsonBody(post(big))) === BAD_REQUEST);
    check("an oversized body is never handed to the parser", !parsed);
  } finally {
    JSON.parse = original;
  }

  const atCap = `{"name":"${"y".repeat(JSON_BODY_MAX_BYTES - 11)}"}`;
  check("the cap is inclusive", new TextEncoder().encode(atCap).byteLength === JSON_BODY_MAX_BYTES);
  const edge = await parseJsonBody<{ name: string }>(post(atCap));
  check("a body exactly at the cap is parsed", edge !== BAD_REQUEST && edge.name.length === JSON_BODY_MAX_BYTES - 11);
  console.log(`handler: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
