import { deleteFanData, isPlausibleToken } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, parseJsonBody, statusForError } from "@/lib/api/handler";
import { FAN_DELETE_PHRASE, LIMITS } from "@/lib/privacy/config";
import { privateError, privateJson, tokenKey } from "@/lib/privacy/respond";

// A fan permanently deletes their own data. Body: { token, confirm }, where
// confirm is the word the page asked them to type. Same semantics as the
// creator deleting the fan (src/lib/data/privacy.ts → deleteFanData).
export async function POST(req: Request) {
  const byIp = await rateLimitOr429("fandelete:ip:" + clientIp(req), ...LIMITS.fanDeletePerIp);
  if (byIp) return byIp;

  const body = await parseJsonBody<{ token?: unknown; confirm?: unknown }>(req);
  if (body === BAD_REQUEST || !isPlausibleToken(body.token)) return privateError("bad_request", 400);
  if (typeof body.confirm !== "string" || body.confirm.trim().toUpperCase() !== FAN_DELETE_PHRASE) {
    return privateError("confirm_mismatch", 400);
  }

  const byToken = await rateLimitOr429(await tokenKey("fandelete", body.token), ...LIMITS.fanDeletePerToken);
  if (byToken) return byToken;

  const result = await deleteFanData(body.token);
  if ("error" in result) return privateError(result.error, statusForError(result.error));
  return privateJson({ ok: true, spinsKept: result.spinsKept });
}
