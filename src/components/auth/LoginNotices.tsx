import { SUPPORT_EMAIL, SUSPENDED_LOGIN_MESSAGE } from "@/lib/auth/authCopy";

/** The sign-in page's query parameters, read once by the page (server-side). */
export interface LoginParams {
  next?: string;
  mode?: string;
  suspended?: string;
  closed?: string;
  error?: string;
  type?: string;
  reason?: string;
}

export function readLoginParams(raw: Record<string, string | string[] | undefined>): LoginParams {
  const pick = (k: keyof LoginParams) => {
    const v = raw[k];
    return typeof v === "string" ? v : undefined;
  };
  return { next: pick("next"), mode: pick("mode"), suspended: pick("suspended"), closed: pick("closed"), error: pick("error"), type: pick("type"), reason: pick("reason") };
}

/**
 * Status notices the sign-in page shows above the form, in the demo too:
 * a suspended account (WU-01 / WG-01) and a closed one. Pure, no state.
 */
export default function LoginNotices({ params }: { params: LoginParams }) {
  return (
    <>
      {params.suspended === "1" && (
        <div data-testid="login-suspended" role="alert" className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <p className="font-bold text-amber-50">Your account is suspended</p>
          <p className="mt-1">{SUSPENDED_LOGIN_MESSAGE}</p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-white underline underline-offset-4">
            Email {SUPPORT_EMAIL}
          </a>
        </div>
      )}
      {params.closed === "1" && (
        <p role="status" className="mt-4 text-sm text-green-300">
          Your account is closed and its data deleted. Thanks for using FanFunnel.
        </p>
      )}
    </>
  );
}
