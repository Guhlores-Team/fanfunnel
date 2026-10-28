import type { ThemeMedia } from "@/lib/creatorTheme/config";

/**
 * The creator's photo hub on the fan page and /c/<slug> (per-creator
 * theming): a sideways-scrolling strip. The strip itself is focusable so
 * keyboard users can scroll it with the arrow keys (no JS, no motion), and
 * each photo is lazy-loaded at its stored size. Captions are plain text.
 */
export default function PhotoGallery({
  media,
  creatorTitle,
  compact = false,
}: {
  media: ThemeMedia[];
  creatorTitle: string;
  compact?: boolean;
}) {
  if (media.length === 0) return null;
  const n = media.length;
  return (
    <section aria-label={`Photos from ${creatorTitle}`} className="w-full min-w-0" data-testid="photo-gallery">
      <p aria-hidden="true" className="text-left text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        Gallery
      </p>
      <ul
        role="list"
        tabIndex={0}
        aria-label={n > 1 ? `${n} photos, scroll sideways for more` : "1 photo"}
        className="mt-2.5 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
      >
        {media.map((m, i) => (
          <li key={m.id} className={`${compact ? "w-24" : "w-36 sm:w-40"} shrink-0 snap-start`}>
            <figure className="m-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- creator photo from the creator-media bucket */}
              <img
                src={m.url}
                alt={`Photo ${i + 1} of ${n} from ${creatorTitle}`}
                width={m.width}
                height={m.height}
                loading="lazy"
                decoding="async"
                className="aspect-[4/5] w-full rounded-2xl border border-line bg-surface object-cover"
              />
              {m.caption && !compact && (
                <figcaption className="mt-1.5 line-clamp-2 text-left text-xs text-muted">{m.caption}</figcaption>
              )}
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
