// C4 (batch 6): the creator types the claim code a fan sent with a screenshot
// and this page says whether it belongs to this win. The code is never shown
// here (this page is public); a match proves the sender held the fan's win
// page, not who they are.
export type ClaimCheckState = "none" | "match" | "mismatch" | "limited" | "unavailable";

const RESULT: Record<Exclude<ClaimCheckState, "none">, { text: string; tone: string }> = {
  match: { text: "This claim code matches this win.", tone: "text-emerald-300" },
  mismatch: { text: "This claim code does not match this win.", tone: "text-red-300" },
  limited: { text: "Too many checks from this connection. Try again in a minute.", tone: "text-amber-200" },
  unavailable: { text: "Claim codes can't be checked right now.", tone: "text-amber-200" },
};

export default function ClaimCheck({ state, value }: { state: ClaimCheckState; value: string }) {
  const result = state === "none" ? null : RESULT[state];
  return (
    <section aria-labelledby="claim-check-title" className="mt-6 border-t border-line pt-5">
      <h2 id="claim-check-title" className="text-sm font-bold text-ink">Check a claim code</h2>
      <p className="mt-1 text-xs text-muted text-pretty">
        The fan&rsquo;s win card shows a 6-character code. It proves the sender has the fan&rsquo;s own win page, not who
        they are.
      </p>
      <form method="get" className="mt-3 flex gap-2">
        <label htmlFor="claim-code" className="sr-only">Claim code</label>
        <input
          id="claim-code"
          name="code"
          defaultValue={value}
          maxLength={12}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 w-36 rounded-lg border border-line bg-surface-2 px-3 font-mono uppercase text-ink"
        />
        <button type="submit" className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold text-ink hover:bg-surface-2">
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
