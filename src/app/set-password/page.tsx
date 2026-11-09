import NewPasswordForm from "@/components/auth/NewPasswordForm";

// An admin's "New account" invite e-mail → /auth/callback (or /auth/confirm)
// → here: the invited creator chooses their own password (C8).
export default function SetPasswordPage() {
  return <NewPasswordForm variant="welcome" />;
}
