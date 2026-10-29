/** Scratch-v1 visible identity, shared with PostgreSQL _scratch_visible.
 * No locale case mapping: preserve non-ASCII Unicode after NFKC. This exact
 * edge-whitespace set is pinned to ECMAScript, including the FEFF BOM. */
const EDGE_SPACE = /^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/gu;
export function visibleIdentity(value:string):string {
  return value.normalize("NFKC").replace(/[\uFE0E\uFE0F\u200D]/gu, "").replace(EDGE_SPACE, "")
    .replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));
}
