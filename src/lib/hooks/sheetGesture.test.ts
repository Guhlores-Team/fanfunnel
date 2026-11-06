import assert from "node:assert";
import { shouldDismissSheet } from "./sheetGesture";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

check("no movement never dismisses", !shouldDismissSheet(0, 5, 600));
check("upward drag never dismisses", !shouldDismissSheet(-200, 2, 600));
check("short slow pull snaps back", !shouldDismissSheet(60, 0.1, 600));
check("long pull dismisses (capped at 120px)", shouldDismissSheet(120, 0.1, 600));
check("just under the cap snaps back", !shouldDismissSheet(119, 0.1, 600));
check("a quarter of a short sheet dismisses", shouldDismissSheet(60, 0.1, 240));
check("tiny sheets still need 48px", !shouldDismissSheet(40, 0.1, 100) && shouldDismissSheet(48, 0.1, 100));
check("quick flick dismisses", shouldDismissSheet(30, 0.8, 600));
check("a flick needs some travel", !shouldDismissSheet(10, 3, 600));

console.log(`sheetGesture: ${passed} checks passed`);
