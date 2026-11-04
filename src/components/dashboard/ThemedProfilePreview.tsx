"use client";

import ThemeBackdrop from "@/components/theme/ThemeBackdrop";
import PhotoGallery from "@/components/theme/PhotoGallery";
import { DEFAULT_THEME } from "@/lib/creatorTheme/config";
import { themeFontFamily } from "@/lib/creatorTheme/fonts";
import { themeStyle } from "@/lib/creatorTheme/tokens";
import type { ThemePreviewValue } from "./lookAndFeel";
import { publicGameCopy } from "@/lib/games/publicCopy";

/** The public-page preview shares its fonts, background and gallery renderer. */
export default function ThemedProfilePreview({
  brandColor,
  avatarUrl,
  displayName,
  tagline,
  hasTipUrl,
  look,
  gameKind,
}: {
  brandColor: string;
  avatarUrl: string;
  displayName: string;
  tagline: string;
  hasTipUrl: boolean;
  look: ThemePreviewValue | null;
  /** The live game's kind; the public page's copy follows it. */
  gameKind?: string;
}) {
  const theme = look?.theme ?? DEFAULT_THEME;
  const { style, plan } = themeStyle(theme, brandColor, themeFontFamily(theme.font));
  const name = displayName.trim() || "Creator";
  const copy = publicGameCopy(gameKind);
  return (
    <div
      className="relative isolate min-w-0 overflow-hidden rounded-2xl border border-[var(--hair)] shadow-[var(--lift)] [transform:translateZ(0)]"
      style={style}
      data-testid="theme-preview"
      data-theme-font={theme.font}
      data-theme-background={theme.background}
    >
      <ThemeBackdrop position="absolute" bgUrl={look?.bgUrl} heavyGrain={plan.grains.length > 1} />
      <div className="relative z-[1] flex min-h-[420px] flex-col items-center justify-center px-6 py-10">
        <div className="w-full min-w-0 max-w-xs text-center">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- matches the public avatar
            <img src={avatarUrl} alt="" className="mx-auto mb-5 h-20 w-20 rounded-full object-cover ring-2 ring-[var(--brand)]" />
          ) : (
            <div aria-hidden="true" className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-surface text-4xl">{copy.emoji}</div>
          )}
          <p className="font-display text-2xl font-extrabold text-ink [overflow-wrap:anywhere]">{name}</p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-pretty text-muted [overflow-wrap:anywhere]">
            {tagline || copy.defaultTagline}
          </p>
          {hasTipUrl ? (
            <span className="btn-brand mt-7 inline-block w-full rounded-2xl py-3.5 text-base font-extrabold">{copy.cta}</span>
          ) : (
            <p className="mt-7 text-sm text-muted [overflow-wrap:anywhere]">{copy.dmLine(name)}</p>
          )}
          <p className="mt-3 text-xs text-muted">{copy.everyPlayWins}</p>
          {!!look?.media.length && (
            <div className="mt-7"><PhotoGallery media={look.media} creatorTitle={name} compact /></div>
          )}
        </div>
      </div>
    </div>
  );
}
