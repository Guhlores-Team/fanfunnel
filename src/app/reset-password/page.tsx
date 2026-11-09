import NewPasswordForm from "@/components/auth/NewPasswordForm";

// Recovery e-mail → /auth/callback (or /auth/confirm) → here.
export default function ResetPasswordPage() {
  return <NewPasswordForm variant="reset" />;
}
