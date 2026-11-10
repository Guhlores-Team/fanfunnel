import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-level contracts of the fan page that a browser test cannot see
// cheaply (per-frame work, stale closures) or that must not regress quietly.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const wheel = read("../Wheel.tsx");
const controller = read("./FanGameController.tsx");
const reveal = read("../reveal/RewardReveal.tsx");
const legalLinks = read("../LegalLinks.tsx");
const safety = read("./SafetyMenu.tsx");

// PA-02: the spin turns the canvas with a CSS transform; nothing is repainted per frame.
const tickStart = wheel.indexOf("const tick = (now: number) => {");
const tickEnd = wheel.indexOf("rafRef.current = requestAnimationFrame(tick);", tickStart);
const tick = wheel.slice(tickStart, tickEnd);
check("PA-02: the per-frame tick is found", tickStart > 0 && tickEnd > tickStart);
check("PA-02: the tick turns the canvas by transform", /turnTo\(rotationRef\.current\)/.test(tick) && /canvas\.style\.transform = `rotate\(\$\{rotation\}rad\)`/.test(wheel));
check("PA-02: the tick never repaints the face", !/\bdraw\(/.test(tick) && !/getContext|fillText|createRadialGradient|createLinearGradient/.test(tick));
check("PA-02: the stop clears the transform and paints the landed face once",
  /canvas\.style\.transform = ""; canvas\.style\.willChange = "";\s*\}\s*draw\(rotationRef\.current\);/.test(wheel));
check("PA-02: a repaint mid-spin (new props) stays upright under the transform", /draw\(spinningRef\.current \? 0 : rotationRef\.current\)/.test(wheel));

// RF-11: the wheel's first paint fits a 320px phone.
check("RF-11: the wheel is capped to the viewport before it is measured", /maxWidth: "calc\(100vw - 48px\)", aspectRatio: "1 \/ 1"/.test(wheel));

// RF-12: sound and haptics follow the mute switch as it is at that moment.
check("RF-12: the controller keeps the switch in a ref", /const mutedRef = useRef\(muted\);/.test(controller) && /mutedRef\.current = muted;/.test(controller));
check("RF-12: the win sound and build-up read the ref", /if \(!mutedRef\.current && !recoveredWin\.current\) \{\s*playWin\(/.test(controller) && /!mutedRef\.current && !recoveredWin\.current && rv\.tier\?\.buildUp/.test(controller));
check("RF-12: the wheel's ticks and landing haptic read a ref too", /if \(!mutedRef\.current\) playTick\(\);/.test(wheel) && /if \(!mutedRef\.current\) haptic\(/.test(wheel));

// RF-14 / WF-01: the backdrop never closes the win card; Escape asks first when a code is shown.
const backdrop = /<div\s+aria-hidden="true"\s+className="fixed inset-0 bg-black\/75[^>]*\/>/.exec(reveal)?.[0] ?? "";
check("RF-14: the backdrop is found and has no click handler", backdrop.length > 0 && !/onClick|onPointerDown|onMouseDown/.test(backdrop));
check("WF-01: Escape goes through the confirmation", /onEscape: requestClose/.test(reveal) && /if \(askBeforeClose && !confirmClose\) \{ setConfirmClose\(true\); return; \}/.test(reveal));

// PA-12: one "Legal" navigation landmark per page.
check("PA-12: the second copy is a plain group", /if \(!landmark\) return <div className=\{classes\}>\{links\}<\/div>;/.test(legalLinks));
check("PA-12: the Safety sheet uses the plain copy", /<LegalLinks className="mt-3" landmark=\{false\} \/>/.test(safety) && (safety.match(/<LegalLinks/g) ?? []).length === 1);

// m6 with TS-14: the play button is mounted only once the gate is passed, so
// the focus hand-off is retried from an effect that runs after that render.
const onAck = controller.slice(controller.indexOf("onAck={() => {"), controller.indexOf("/>", controller.indexOf("onAck={() => {")));
check("m6: focus is handed to the play button after the gate's render, never on a frame that may come before it",
  /useEffect\(\(\) => \{ tryRefocusPlay\(\); \}, \[playDisabled, needsAck, tryRefocusPlay\]\);/.test(controller)
  && /refocusPlay\.current = true;/.test(onAck) && !/requestAnimationFrame/.test(onAck));

// TS-10: scratch and bingo count plays, the wheel counts spins.
check("TS-10: the balance chip names the game's unit", /activeGameKind === "scratch" \|\| activeGameKind === "bingo" \? "Plays left" : "Spins left"/.test(controller));

console.log(`fanPageContracts: ${passed} checks passed`);
