import type { Metadata } from "next";
import NewPasswordForm from "@/components/auth/NewPasswordForm";

export const metadata: Metadata = { title: "Choose a new password · FanFunnel", robots: { index: false, follow: false } };

// Recovery e-mail → /auth/confirm (Continue) → /auth/confirm/verify → here.
export default function ResetPasswordPage() {
  return <NewPasswordForm variant="reset" />;
}
