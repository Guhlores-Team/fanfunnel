import { requireAdminRoute } from "@/lib/auth/admin";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { listStuckDeletions, DELETION_AUTO_RETRIES } from "@/lib/account/deletionRetry";
import { privateError, privateJson } from "@/lib/privacy/respond";

// A18: account deletions that are paused, or in flight but untouched for an
// hour, with their state, last error, attempts, age and next automatic retry.
// Admin (active, aal2) only; ids and states only, no account contents. The
// Retry button posts the id to /api/admin/account/storage-retry.
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  if (!isSupabaseConfigured()) return privateJson({ deletions: [], autoRetries: DELETION_AUTO_RETRIES, demo: true });
  const deletions = await listStuckDeletions(createServiceClient());
  if (!deletions) return privateError("db_error", 500);
  return privateJson({ deletions, autoRetries: DELETION_AUTO_RETRIES });
}
