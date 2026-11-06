import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NewGameDialog from "./NewGameDialog";
import GameSettingsEditor from "./GameSettingsEditor";
import GamePreview from "./GamePreview";
import type { CreatorGameWheel } from "./gameEditor";

const noop = () => {};
const features = { wheel: true as const, scratch: true, bingo: true };
const picker = (enabled: typeof features | null) => renderToStaticMarkup(createElement(NewGameDialog, { features: enabled, busy: false, error: "", onCreate: noop, onClose: noop }));
for (const enabled of [null, { ...features, scratch: false, bingo: false }]) {
  const html = picker(enabled);
  assert.match(html, /new-game-kind-wheel/);
  assert.ok(!html.includes("new-game-kind-scratch") && !html.includes("new-game-kind-bingo"), "unknown or disabled account capabilities must hide extra choices");
  assert.match(html, /role="dialog"/);
  assert.match(html, /type="radio"/);
}
const all = picker(features);
assert.match(all, /new-game-kind-scratch/);
assert.match(all, /new-game-kind-bingo/);
assert.match(all, /Every play wins/);
const pending = renderToStaticMarkup(createElement(NewGameDialog, { features, busy: true, error: "", onCreate: noop, onClose: noop }));
assert.match(pending, /fieldset[^>]*disabled/);
assert.match(pending, /Creating/);

const wheel: CreatorGameWheel = { id: "example", title: "Game", prizes: [] };
const settings = (game: CreatorGameWheel) => renderToStaticMarkup(createElement(GameSettingsEditor, { wheel: game, features, disabled: false, onChange: noop }));
assert.match(settings(wheel), /data-testid="game-kind"[^>]*disabled/, "missing server lock metadata cannot permit conversion");
assert.ok(!/data-testid="game-kind"[^>]*disabled/.test(settings({ ...wheel, gameKindLocked: false })), "an explicit server unlocked value permits the presentation control");
const draft = settings({ ...wheel, gameKind: "bingo", gameConfig: { size: 3, linePrizeId: null }, gameReady: false });
assert.match(draft, /Inactive draft/);
assert.match(draft, /before activating it or using it with fan links/);
assert.match(draft, /data-testid="bingo-line-prize"/);
assert.match(draft, /Active cards keep paid progress/);
assert.ok(!draft.includes('data-testid="bingo-value-preview"'), "invalid drafts must not present an apparently valid cost forecast");
const scratch = renderToStaticMarkup(createElement(GamePreview, { wheel: { ...wheel, gameKind: "scratch", gameConfig: { style: "classic" } } }));
assert.match(scratch, /No result is shown/);
assert.match(scratch, /Reveal all/);
assert.equal((scratch.match(/>\?<\/span>/g) ?? []).length, 9, "creator scratch illustration shows nine covered cells and no invented outcome");
const bingo = renderToStaticMarkup(createElement(GamePreview, { wheel: { ...wheel, gameKind: "bingo", gameConfig: { size: 3, linePrizeId: null } } }));
assert.match(bingo, /Example 3 by 3 bingo layout, without marks/);
assert.equal((bingo.match(/<td /g) ?? []).length, 9);
console.log("gameEditorView.test: server-capability visibility, unknown lock refusal, draft protection and honest preview markup passed");
