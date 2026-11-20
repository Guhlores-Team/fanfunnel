import { exportFanData, isPlausibleToken } from "@/lib/data";
import { withFanMissLimit } from "@/lib/api/fanMiss";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { LIMITS } from "@/lib/privacy/config";
import { exportFileName } from "@/lib/privacy/exportTypes";
import { jsonDownload, privateError, tokenKey } from "@/lib/privacy/respond";
import { refuseCreatorSession } from "@/lib/fan/creatorGuard";

// A fan downloads their own data. Body: { token }. The token is the fan's only
// credential, so the export is exactly the records that token resolves to
// (src/lib/data/privacy.ts pins every read to that fan + creator). POST so the
// token never lands in a URL, log line or browser history.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: unknown }>(req);
  const token = body !== BAD_REQUEST && isPlausibleToken(body.token) ? body.token : null;
  if (token) {
    // ATK-01: the export is the fan's; the creator has their own data export.
    // First, so it never spends the fan's budgets below.
    const refused = await refuseCreatorSession(req, token);
    if (refused) return refused;
  }
  return withFanMissLimit(req, async () => {
    const byIp = await rateLimitOr429("fanexport:ip:" + clientIp(req), ...LIMITS.fanExportPerIp);
    if (byIp) return byIp;

    if (!token) return privateError("bad_request", 400);

    const byToken = await rateLimitOr429(await tokenKey("fanexport", token), ...LIMITS.fanExportPerToken);
    if (byToken) return byToken;

    const data = await exportFanData(token);
    if (!data) return privateError("not_found", 404);
    return jsonDownload(data, exportFileName("fan", new Date()));
  });
}
