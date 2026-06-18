// Shared password policy for creator accounts so the admin-invite and
// self-service-change paths can't drift (admin invite previously allowed 6 chars
// while the change endpoint required 8). Deliberately moderate: a length floor
// plus a letter+digit mix — rules out trivially weak values without rejecting
// strong passphrases. Supabase Auth applies its own policy on top of this.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function isAcceptablePassword(pw: unknown): pw is string {
  if (typeof pw !== "string") return false;
  if (pw.length < MIN_PASSWORD_LENGTH || pw.length > MAX_PASSWORD_LENGTH) return false;
  return /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}
