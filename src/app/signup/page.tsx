import { redirect } from "next/navigation";

// WC-08 / WU-18: the handoff notes send new creators to /signup. It is the
// sign-in page's "create your login" mode; a signed-in user is already sent to
// the dashboard by the proxy before this runs.
export default function SignupPage() {
  redirect("/login?mode=signup");
}
