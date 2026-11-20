import { exportCreatorData } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getSessionAssurance } from "@/lib/auth/assurance";
import { mfaStepUpResponse } from "@/lib/auth/stepUp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { LIMITS } from "@/lib/privacy/config";
import { exportFileName } from "@/lib/privacy/exportTypes";
import { jsonDownload, privateError } from "@/lib/privacy/respond";

// The signed-in creator downloads everything their account owns. Generated
// with THEIR session client (RLS applies) and filtered to their own id
// (src/lib/data/privacy.ts → exportCreatorData); no service role. A creator
// who turned two-factor on must have used it in this session.
export async function GET() {
  if (!isSupabaseConfigured()) {
    // Demo: the in-memory demo account (no accounts, no auth).
    const data = await exportCreatorData();
    return data ? jsonDownload(data, exportFileName("creator", new Date())) : privateError("not_found", 404);
  }

  const sb = await createClient();
  const { userId, assurance } = await getSessionAssurance(sb);
  if (!userId) return privateError("unauthorized", 401);

  const limited = await rateLimitOr429("creatorexport:" + userId, ...LIMITS.creatorExport);
  if (limited) return limited;
  const step = mfaStepUpResponse(assurance);
  if (step) return step;

  const data = await exportCreatorData();
  if (!data) return privateError("unauthorized", 401);
  return jsonDownload(data, exportFileName("creator", new Date()));
}
