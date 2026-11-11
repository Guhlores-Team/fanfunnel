import type { Metadata } from "next";
import NewPasswordForm from "@/components/auth/NewPasswordForm";

export const metadata: Metadata = { title: "Set your password · FanFunnel", robots: { index: false, follow: false } };

// An admin's "New account" invite e-mail → /auth/confirm (Continue) →
// /auth/confirm/verify → here: the invited creator chooses their own password (C8).
export default function SetPasswordPage() {
  return <NewPasswordForm variant="welcome" />;
}
