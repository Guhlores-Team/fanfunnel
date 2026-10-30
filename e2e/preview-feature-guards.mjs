// Pure policy for the optional hosted smoke. Import the frozen shared guard;
// never fork its immutable Preview, exact source, project/team or TEST checks.
import { TEST_ORIGIN, previewPerfEnvironment, refuse } from "./preview-lcp-guards.mjs";

export const SHARED_GUARD_SHA256 = "b5675aa69816b830783f49adeaef4ffb4f444361d4ddd4ba935425a6d0b308e5";
export const MAX_BINGO_PLAYS = 36;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const SAFE_SHARE_ID = /^[A-Za-z0-9_-]{12,80}$/;
export const ensure = (condition, code) => { if (!condition) refuse(code); };

export function previewFeatureEnvironment(env) {
  ensure(typeof env.PREVIEW_FEATURE_URL === "string" && env.PREVIEW_FEATURE_URL.length > 0, "FEATURE_PREVIEW_REQUIRED");
  return previewPerfEnvironment({ ...env, PREVIEW_PERF_URL: env.PREVIEW_FEATURE_URL });
}
export function featureBrowserUrlAllowed(value, origin) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && [origin, TEST_ORIGIN].includes(url.origin);
  } catch { return false; }
}
export function ownFixtureUser(user, owner, email) {
  return UUID.test(owner ?? "") && typeof email === "string" && user?.id === owner && user.email === email;
}
export function safeApiUrl(origin, path) {
  ensure(typeof path === "string" && path.startsWith("/api/") && !path.includes("\\") && !path.includes("#"), "INVALID_SMOKE_API_PATH");
  let url;
  try { url = new URL(path, origin); } catch { refuse("INVALID_SMOKE_API_PATH"); }
  ensure(url.origin === origin && url.pathname.startsWith("/api/") && !url.username && !url.password, "INVALID_SMOKE_API_PATH");
  return url.href;
}
export function checkPrimaryReceipt(result, kind, beforeBalance) {
  ensure(result && typeof result === "object" && (result.gameKind ?? "wheel") === kind && SAFE_SHARE_ID.test(result.shareId ?? "")
    && UUID.test(result.attemptId ?? "") && typeof result.prize?.id === "string"
    && result.spinsRemaining === beforeBalance - 1 && (result.bonusWins === undefined || Array.isArray(result.bonusWins)), "PRIMARY_RECEIPT_UNVERIFIED");
  if (kind === "scratch") ensure(result.presentation?.kind === "scratch" && result.presentation.cells?.length === 9, "SCRATCH_FACE_UNVERIFIED");
  if (kind === "bingo") ensure(result.presentation?.kind === "bingo" && result.presentation.after?.cells?.length === 9
    && Number.isSafeInteger(result.presentation.after.markedMask) && Array.isArray(result.presentation.newLines), "BINGO_CARD_UNVERIFIED");
}
export function checkReplay(first, replay) {
  ensure(replay?.replayed === true && replay.attemptId === first.attemptId && replay.shareId === first.shareId
    && replay.prize?.id === first.prize.id && replay.spinsRemaining === first.spinsRemaining
    && JSON.stringify(replay.presentation) === JSON.stringify(first.presentation)
    && JSON.stringify(replay.bonusWins) === JSON.stringify(first.bonusWins)
    && JSON.stringify(replay.reward) === JSON.stringify(first.reward), "REPLAY_RECEIPT_UNVERIFIED");
}
export function checkCleanupBeforeAuth({ acknowledged, userAbsent, owned, media, storage, publicObjects }) {
  ensure(!(userAbsent && !acknowledged), "CLEANUP_CREATE_UNCONFIRMED");
  ensure(userAbsent || owned === true, "CLEANUP_OWNERSHIP_UNVERIFIED");
  ensure([media, storage, publicObjects].every(value => Number.isSafeInteger(value) && value >= 0), "CLEANUP_STORAGE_UNVERIFIED");
  ensure(media === 0 && storage === 0 && publicObjects === 0, "CLEANUP_PENDING_STORAGE");
}


export const INSTANT_HEALTH_MAX_AGE_MS = 15 * 60_000;
/** Read-only observation, never key enrollment/repair or proof of backup. */
export function checkInstantHealth(row, now = Date.now()) {
  const checked = typeof row?.canary_checked_at === "string" ? Date.parse(row.canary_checked_at) : NaN;
  ensure(row?.canary_status === "healthy" && row.canary_failure_at === null
    && Number.isFinite(checked) && Number.isFinite(now) && checked <= now
    && now - checked <= INSTANT_HEALTH_MAX_AGE_MS, "INSTANT_CANARY_NOT_VERIFIED");
}
export function checkNoPrivateReward(value, codes) {
  ensure(Array.isArray(codes) && codes.length === 2 && codes.every(code => typeof code === "string" && code.length > 16), "INSTANT_POOL_UNVERIFIED");
  const visit = current => {
    if (typeof current === "string") return !codes.some(code => current.includes(code));
    if (current === null || typeof current !== "object") return true;
    return Object.entries(current).every(([key, child]) => !/^(?:cipher|iv|fingerprint|reward_cipher|reward_iv|reward_fingerprint)$/i.test(key) && visit(child));
  };
  ensure(visit(value), "INSTANT_PRIVATE_FIELD_EXPOSED");
}
export function checkPublicRewardDocument(html, codes) {
  checkNoPrivateReward(html, codes);
  // Detect JSON/RSC encrypted-field keys, including escaped double quotes.
  ensure(typeof html === "string" && !/(?:\\*["'])(?:cipher|iv|fingerprint|reward_cipher|reward_iv|reward_fingerprint)(?:\\*["'])\s*:/i.test(html), "INSTANT_PRIVATE_FIELD_EXPOSED");
}
export function checkInstantStock(delivery, left, used, codes) {
  checkNoPrivateReward(delivery, codes);
  ensure(delivery?.delivery === "codes" && delivery.ready === true && delivery.value === null
    && delivery.codesLeft === left && delivery.codesUsed === used
    && Array.isArray(delivery.preview) && delivery.preview.length === left
    && delivery.preview.every(hint => typeof hint === "string" && hint.startsWith("••••")), "INSTANT_STOCK_UNVERIFIED");
}
export function checkInstantWin(result, prizeId, codes) {
  ensure(result?.prize?.id === prizeId && result.reward?.kind === "code"
    && codes.includes(result.reward.value), "INSTANT_WIN_UNVERIFIED");
}

export function checkInstantEconomy(detail, fanId, balance, plays) {
  ensure(detail?.fanId === fanId && detail.spinsRemaining === balance && detail.grantedTotal === 2
    && detail.totalSpins === plays && Array.isArray(detail.links) && detail.links.length === 1
    && Array.isArray(detail.grants) && detail.grants.length === 1
    && detail.grants[0].spins === 2 && detail.grants[0].editPass?.spinsRemaining === balance, "INSTANT_ECONOMY_UNVERIFIED");
}
