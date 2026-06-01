"use client";

/**
 * A small personal touch atop the fan page: the creator's avatar + a one-line
 * note. Parasocial warmth converts far better than a bare title. Renders nothing
 * if the creator set neither.
 */
export default function CreatorNote({
  creatorTitle,
  note,
  avatarUrl,
  fanName,
}: {
  creatorTitle: string;
  note?: string | null;
  avatarUrl?: string | null;
  fanName?: string | null;
}) {
  if (!note && !avatarUrl) return null;
  return (
    <div className="reveal flex items-center gap-3 rounded-2xl border border-line bg-surface/60 px-4 py-3" style={{ animationDelay: "0.08s" }}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={creatorTitle}
          className="h-11 w-11 shrink-0 rounded-full object-cover ring-2 ring-[var(--brand)]"
        />
      ) : (
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg ring-2 ring-[var(--brand)]"
          style={{ background: "color-mix(in oklab, var(--brand) 25%, transparent)" }}
        >
          💌
        </span>
      )}
      <p className="min-w-0 text-sm text-ink text-pretty">
        {note || `Hey${fanName ? ` ${fanName}` : ""}, spin away! — ${creatorTitle}`}
      </p>
    </div>
  );
}
