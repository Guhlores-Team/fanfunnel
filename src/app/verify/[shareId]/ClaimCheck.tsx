"use client";

import { useState, type FormEvent } from "react";
import { isClaimCheckState, type ClaimCheckState } from "@/lib/fan/claimCheck";

// C4 (batch 6): the creator types the claim code a fan sent with a screenshot
// and this page says whether it belongs to this win. The code is never shown
// here (this page is public); a match proves the sender held the fan's win
// page, not who they are. WF-17: the code is POSTed to /api/public/claim-check
// (a form post without JS redirects back with only the verdict), so it never
// appears in this page's URL.
export type { ClaimCheckState };

const RESULT: Record<Exclude<ClaimCheckState, "none">, { text: string; tone: string }> = {
  match: { text: "This claim code matches this win.", tone: "text-emerald-300" },
  mismatch: { text: "This claim code does not match this win.", tone: "text-red-300" },
  limited: { text: "Too many checks from this connection. Try again in a minute.", tone: "text-amber-200" },
  unavailable: { text: "Claim codes can't be checked right now.", tone: "text-amber-200" },
};

export default function ClaimCheck({ shareId, initial }: { shareId: string; initial: ClaimCheckState }) {
  const [state, setState] = useState<ClaimCheckState>(initial);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const result = state === "none" ? null : RESULT[state];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/public/claim-check", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ shareId, code }),
      });
      const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
      setState(res.status === 429 ? "limited" : isClaimCheckState(body?.state) ? body.state : "unavailable");
    } catch {
      setState("unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="claim-check-title" className="mt-6 border-t border-line pt-5">
      <h2 id="claim-check-title" className="text-sm font-bold text-ink">Check a claim code</h2>
      <p className="mt-1 text-xs text-muted text-pretty">
        The fan&rsquo;s win card shows a 6-character code. It proves the sender has the fan&rsquo;s own win page, not who
        they are.
      </p>
      <form method="post" action="/api/public/claim-check" onSubmit={onSubmit} className="mt-3 flex gap-2">
        <input type="hidden" name="shareId" value={shareId} />
        <label htmlFor="claim-code" className="sr-only">Claim code</label>
        <input
          id="claim-code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={12}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 w-36 rounded-lg border border-line bg-surface-2 px-3 font-mono uppercase text-ink"
        />
        <button type="submit" aria-disabled={busy || undefined} className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold text-ink hover:bg-surface-2">
          Check
        </button>
      </form>
      {result && (
        <p role="status" data-testid="claim-check" data-state={state} className={`mt-2 text-sm font-semibold ${result.tone}`}>
          {result.text}
        </p>
      )}
    </section>
  );
}
