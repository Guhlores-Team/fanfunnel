import { NOIR_GRAIN_ALPHA } from "@/lib/creatorTheme/tokens";

/**
 * The themed page background (per-creator theming): the computed
 * `--theme-background` (hex colours and gradients only, from tokens.ts), the
 * film grain, and for "Your photo" the creator's re-encoded photo, blurred,
 * under the `--theme-scrim` solved so ANY photo keeps text AA.
 *
 * The photo is an <img>, never a CSS url(), so nothing a creator uploads can
 * reach a stylesheet. Decorative: hidden from assistive tech. `fixed` behind a
 * fan page; `absolute` inside a preview (whose box must contain fixed
 * children, e.g. via a transform, because the grain layer is position: fixed).
 */
export default function ThemeBackdrop({
  bgUrl,
  heavyGrain = false,
  position = "fixed",
}: {
  bgUrl?: string | null;
  heavyGrain?: boolean;
  position?: "fixed" | "absolute";
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="theme-backdrop"
      className={`grain pointer-events-none ${position} inset-0 z-0 overflow-hidden`}
      style={{ background: "var(--theme-background)" }}
    >
      {bgUrl && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- creator photo from the creator-media bucket */}
          <img
            src={bgUrl}
            alt=""
            decoding="async"
            data-testid="theme-photo"
            className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl"
          />
          <div className="absolute inset-0" style={{ background: "var(--theme-scrim)" }} />
        </>
      )}
      {heavyGrain && <div className="theme-noise absolute inset-0" style={{ opacity: NOIR_GRAIN_ALPHA }} />}
    </div>
  );
}
