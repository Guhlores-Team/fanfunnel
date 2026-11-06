"use client";

import { useEffect, useId, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import WheelGlyph from "@/lib/pwa/WheelGlyph";
import { DEFAULT_PWA_ICON_MODE, NEUTRAL_APP_NAME, type PwaIconMode } from "@/lib/pwa/config";
import { avatarSource, isPwaIconMode, shortName } from "@/lib/pwa/manifest";
import { readableInk } from "@/lib/theme";

// Settings › Public page › Home-screen icon (RM-4, owner decision D8). Mounted
// with one line from SettingsPanel's Public page section; styles match its cards.
const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const primaryBtn =
  "btn-brand inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] px-[18px] text-sm font-bold disabled:opacity-50";

const OPTIONS: { mode: PwaIconMode; label: string; hint: string }[] = [
  { mode: "neutral", label: "Neutral (recommended)", hint: `A wheel in your brand colour, named “${NEUTRAL_APP_NAME}”.` },
  { mode: "avatar", label: "My avatar", hint: "Your photo and display name." },
];

export default function HomeScreenIconCard({
  brandColor,
  avatarUrl,
  displayName,
}: {
  brandColor: string;
  avatarUrl: string;
  displayName: string;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<PwaIconMode>(DEFAULT_PWA_ICON_MODE);
  const [saved, setSaved] = useState<PwaIconMode>(DEFAULT_PWA_ICON_MODE);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const name = shortName(displayName.trim() || "Creator");
  // Only an avatar uploaded here (the public avatars bucket) can be drawn into
  // the icon; anything else falls back to the neutral wheel on the server.
  const avatarUsable = !!avatarSource(avatarUrl || null, process.env.NEXT_PUBLIC_SUPABASE_URL);

  useEffect(() => {
    let live = true;
    fetch("/api/account/pwa-icon", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live) return;
        if (d && isPwaIconMode(d.mode)) {
          setMode(d.mode);
          setSaved(d.mode);
        }
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/pwa-icon", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error();
      setSaved(mode);
      toast("Home-screen icon saved", { tone: "success" });
    } catch {
      toast("Couldn't save the home-screen icon.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className={`min-w-0 space-y-4 rounded-2xl p-5 ${raised}`}>
      <div>
        <h3 id={titleId} className="flex items-center gap-2 text-[15px] font-bold text-ink">
          <span className="text-brand">
            <PhoneGlyph />
          </span>
          Home-screen icon
        </h3>
        <p className="mt-1 text-xs text-muted">
          What fans see if they add their spin link to their phone. Neutral keeps your name and
          photo off their home screen.
        </p>
      </div>

      <fieldset disabled={!loaded} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Icon and name on fans&rsquo; home screens</legend>
        {OPTIONS.map((o) => (
          <label
            key={o.mode}
            className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-line p-3 transition-colors hover:bg-white/[0.03] has-[:checked]:border-[var(--brand)] has-[:checked]:bg-white/[0.04] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--brand)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input
              type="radio"
              name="pwa-icon-mode"
              value={o.mode}
              checked={mode === o.mode}
              onChange={() => setMode(o.mode)}
              className="sr-only"
            />
            <IconPreview
              mode={o.mode}
              brandColor={brandColor}
              avatarUrl={avatarUsable ? avatarUrl : ""}
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">{o.label}</span>
              <span className="block text-xs text-muted">{o.hint}</span>
              <span className="mt-1 block truncate text-xs text-ink">
                <span className="sr-only">Home-screen name: </span>
                {o.mode === "avatar" ? name : NEUTRAL_APP_NAME}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "avatar" && !avatarUsable && (
        <p className="text-xs text-[#fcd34d]">
          Upload a photo with Change avatar above to use it here. Until then fans get the neutral
          wheel, with your name.
        </p>
      )}
      <p className="text-xs text-muted">
        Applies to new installs. iPhones keep the icon a fan already added.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy || !loaded || mode === saved} className={primaryBtn}>
          {busy ? "Saving…" : "Save icon"}
        </button>
        {mode !== saved && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#fcd34d]" role="status">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" />
            Unsaved changes
          </span>
        )}
      </div>
    </section>
  );
}

function IconPreview({ mode, brandColor, avatarUrl }: { mode: PwaIconMode; brandColor: string; avatarUrl: string }) {
  const box = "grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[12px]";
  if (mode === "avatar" && avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={avatarUrl} alt="" className={`${box} object-cover`} />
    );
  }
  return (
    <span aria-hidden="true" className={box} style={{ background: brandColor }}>
      <WheelGlyph size={36} ink={readableInk(brandColor)} />
    </span>
  );
}

function PhoneGlyph() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}
