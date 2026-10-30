"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  BACKGROUND_LABELS,
  CAPTION_MAX,
  DEFAULT_THEME,
  FONT_LABELS,
  MAX_UPLOAD_BYTES,
  THEME_BACKGROUNDS,
  THEME_FONTS,
  normalizeCaption,
  parseThemeInput,
  type CreatorTheme,
  type ThemeMedia,
} from "@/lib/creatorTheme/config";
import { themeFontFamily } from "@/lib/creatorTheme/fonts";
import { themeSurface } from "@/lib/creatorTheme/tokens";
import { movePhoto, previewValue, readThemeSettings, themeErrorMessage, type ThemePreviewValue, type ThemeSettings } from "./lookAndFeel";

const primary = "btn-brand inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-sm font-bold disabled:opacity-50";
const secondary = "inline-flex min-h-11 items-center justify-center rounded-[10px] border border-line px-3 text-sm font-semibold text-ink transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)] disabled:opacity-50";
const danger = "inline-flex min-h-11 items-center justify-center rounded-[10px] border border-red-400/50 px-3 text-sm font-semibold text-red-300 transition-colors hover:bg-red-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:opacity-50";
const tile = "flex h-full min-w-0 cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface/40 p-3 text-left peer-checked:border-[var(--brand-text)] peer-checked:ring-1 peer-checked:ring-[var(--brand-text)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand-text)] peer-disabled:cursor-not-allowed peer-disabled:opacity-50";

class ThemeRequestError extends Error {
  constructor(public code: string) { super(code); }
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "db_error";
    throw new ThemeRequestError(res.status === 429 ? "rate_limited" : code);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ThemeRequestError("db_error");
  return body as Record<string, unknown>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const errorText = (e: unknown) => themeErrorMessage(e instanceof ThemeRequestError ? e.code : "db_error");

/** Settings' creator-owned appearance and public photo hub. No creator id is submitted. */
export default function LookAndFeelCard({
  displayName,
  brandColor,
  onPreviewChange,
}: {
  displayName: string;
  brandColor: string;
  /** Pass a stable setter so the existing Public page preview can update live. */
  onPreviewChange?: (value: ThemePreviewValue) => void;
}) {
  const id = useId();
  const [view, setView] = useState<ThemeSettings | null>(null);
  const [draft, setDraft] = useState<CreatorTheme>(DEFAULT_THEME);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [attested, setAttested] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const photoHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const pending = useRef(false);
  const dragged = useRef<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    request("/api/account/theme", { signal: abort.signal })
      .then((body) => {
        const next = readThemeSettings(body);
        if (!next) throw new ThemeRequestError("db_error");
        if (abort.signal.aborted) return;
        setView(next);
        setDraft(next.theme);
        setLoadFailed(false);
        setError("");
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setLoadFailed(true);
        setError(e instanceof ThemeRequestError && e.code === "unauthorized"
          ? themeErrorMessage("unauthorized") : "We couldn’t load your saved appearance. Reload it before making changes.");
      })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [reload]);

  useEffect(() => {
    if (view) onPreviewChange?.(previewValue(draft, view.media));
  }, [draft, view, onPreviewChange]);

  useEffect(() => {
    if (error) errorMessage.current?.focus();
  }, [error]);

  const dirty = !!view && (draft.font !== view.theme.font || draft.background !== view.theme.background || draft.bgMediaId !== view.theme.bgMediaId);
  const locked = loading || loadFailed || busy !== null || !view;
  const name = displayName.trim() || "Your name";

  async function action(label: string, task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try { await task(); }
    catch (e) { setError(errorText(e)); }
    finally { pending.current = false; setBusy(null); }
  }

  function reloadSaved() {
    setLoading(true);
    setError("");
    setNotice("");
    setReload((n) => n + 1);
  }

  async function save() {
    await action("Saving appearance…", async () => {
      const body = await request("/api/account/theme", json("PUT", draft));
      const parsed = parseThemeInput(body.theme);
      if ("error" in parsed || !body.theme) throw new ThemeRequestError("db_error");
      setDraft(parsed.theme);
      setView((prev) => prev ? { ...prev, ...previewValue(parsed.theme, prev.media) } : prev);
      setNotice("Look & feel saved. Your public page and fan links now use this appearance.");
    });
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !view) return;
    await action("Uploading photo…", async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("caption", caption);
      form.set("sfw", attested ? "yes" : "no");
      const body = await request("/api/account/media", { method: "POST", body: form });
      const added = body.media as ThemeMedia | undefined;
      const next = readThemeSettings({ ...view, media: [...view.media, added] });
      if (!next) throw new ThemeRequestError("db_error");
      setView(next);
      setFile(null);
      setCaption("");
      setAttested(false);
      if (uploadInput.current) uploadInput.current.value = "";
      setNotice("Photo added to your public gallery.");
    });
  }

  async function reorder(id: string, index: number) {
    if (!view) return;
    const next = movePhoto(view.media, id, index);
    if (next === view.media) return;
    await action("Saving photo order…", async () => {
      await request("/api/account/media", json("PATCH", { order: next.map((m) => m.id) }));
      setView((prev) => prev ? { ...prev, media: next } : prev);
      setNotice(`Photo moved to position ${index + 1} of ${next.length}.`);
    });
  }

  async function saveCaption(id: string, value: string) {
    await action("Saving photo description…", async () => {
      await request(`/api/account/media/${id}`, json("PATCH", { caption: value }));
      setView((prev) => prev ? { ...prev, media: prev.media.map((m) => m.id === id ? { ...m, caption: normalizeCaption(value) } : m) } : prev);
      setNotice("Photo description saved.");
    });
  }

  async function remove(id: string) {
    await action("Removing photo…", async () => {
      await request(`/api/account/media/${id}`, { method: "DELETE" });
      setView((prev) => prev ? { ...prev, ...previewValue(prev.theme, prev.media.filter((m) => m.id !== id)) } : prev);
      setDraft((prev) => prev.bgMediaId === id ? { ...prev, background: DEFAULT_THEME.background, bgMediaId: null } : prev);
      photoHeading.current?.focus();
      setNotice("Photo removed. If it was your background, the background returned to Glow.");
    });
  }

  function startDrag(event: DragEvent<HTMLButtonElement>, mediaId: string) {
    if (locked) { event.preventDefault(); return; }
    dragged.current = mediaId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", mediaId);
  }

  return (
    <section aria-labelledby={`${id}-title`} aria-busy={loading || busy !== null} className="min-w-0 space-y-5 rounded-2xl border border-[var(--hair)] p-5 shadow-[var(--lift)] [background:var(--s1)]" data-testid="look-and-feel-card">
      <div>
        <h3 id={`${id}-title`} className="text-[15px] font-bold text-ink">Look &amp; feel</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">Your headline font, background and gallery appear on every fan link and your public page. Brand color stays with each wheel.</p>
      </div>
      {loading && <p role="status" className="text-sm text-muted">Loading your saved appearance…</p>}
      {error && <p ref={errorMessage} tabIndex={-1} role="alert" className="rounded-lg text-sm text-red-300 outline-offset-4" data-testid="theme-error">{error}</p>}
      {!loading && loadFailed && <button type="button" onClick={reloadSaved} className={secondary}>Reload saved settings</button>}
      {view && <>
        <fieldset disabled={locked} className="min-w-0 space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Headline font</legend>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            {THEME_FONTS.map((font) => (
              <label key={font} className="relative min-w-0">
                <input className="peer sr-only" type="radio" name={`${id}-font`} value={font} aria-label={FONT_LABELS[font]} checked={draft.font === font} onChange={() => setDraft((prev) => ({ ...prev, font }))} data-testid={`theme-font-${font}`} />
                <span className={tile}>
                  <span className="text-[11px] font-medium text-muted">{FONT_LABELS[font]}</span>
                  <span className="text-lg font-bold text-ink [overflow-wrap:anywhere]" style={{ fontFamily: themeFontFamily(font) ?? "var(--ff-display)" }}>{name}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">Body text keeps its clear, readable font.</p>
        </fieldset>
        <fieldset disabled={locked} className="min-w-0 space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Background</legend>
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
            {THEME_BACKGROUNDS.map((background) => {
              const photo = background === "photo";
              return (
                <label key={background} className="relative min-w-0">
                  <input className="peer sr-only" type="radio" name={`${id}-background`} value={background} aria-label={BACKGROUND_LABELS[background]} checked={draft.background === background} disabled={photo && (!view.photosEnabled || view.media.length === 0)} onChange={() => setDraft((prev) => ({ ...prev, background, bgMediaId: photo ? (prev.bgMediaId ?? view.media[0]?.id ?? null) : null }))} data-testid={`theme-background-${background}`} />
                  <span className={tile}>
                    <span aria-hidden="true" className="block h-12 w-full overflow-hidden rounded-lg border border-line" style={{ background: themeSurface(photo ? "glow" : background, brandColor).background }}>
                      {photo && view.media[0] && (
                        // eslint-disable-next-line @next/next/no-img-element -- public, processed gallery thumbnail
                        <img src={view.media[0].url} alt="" className="h-full w-full object-cover" />
                      )}
                    </span>
                    <span className="text-xs font-semibold text-ink">{BACKGROUND_LABELS[background]}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-muted">Presets keep text readable automatically. Photo backgrounds are softened and darkened; upload a photo below to use one.</p>
          {draft.background === "photo" && <label className="block space-y-1 text-xs font-semibold text-muted">
            <span>Background photo</span>
            <select className="ff-input w-full" value={draft.bgMediaId ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, bgMediaId: e.target.value }))} data-testid="theme-background-photo-select">
              {view.media.map((m, index) => <option value={m.id} key={m.id}>{m.caption || `Photo ${index + 1}`}</option>)}
            </select>
          </label>}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={locked || !dirty} onClick={save} className={primary} data-testid="theme-save">{busy === "Saving appearance…" ? busy : "Save look & feel"}</button>
          {dirty && <span className="text-xs text-muted">Unsaved appearance changes</span>}
          {!dirty && !locked && <span className="text-xs text-muted">Appearance saved</span>}
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <div>
            <h4 ref={photoHeading} tabIndex={-1} className="text-sm font-bold text-ink outline-offset-4" id={`${id}-photos`}>Photo hub <span className="font-normal text-muted">{view.media.length}/{view.maxMedia}</span></h4>
            <p className="mt-1 text-xs leading-relaxed text-muted">These photos are public, including on your link-in-bio page. Add only safe-for-work photos you have permission to share.</p>
          </div>
          {!view.photosEnabled && <p className="text-xs text-muted">Photo uploads are currently unavailable.</p>}
          {view.photosEnabled && <form onSubmit={upload} className="space-y-3 rounded-xl border border-line bg-base/40 p-3" aria-label="Add a public gallery photo">
            <fieldset disabled={locked || view.media.length >= view.maxMedia} className="min-w-0 space-y-3">
              <label className="block space-y-1 text-xs font-semibold text-muted">
                <span>Choose photo</span>
                <input ref={uploadInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="block w-full min-w-0 text-xs text-muted file:mr-2 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink" data-testid="theme-photo-file" onChange={(e) => {
                  const picked = e.target.files?.[0] ?? null;
                  setError("");
                  if (picked && picked.size > MAX_UPLOAD_BYTES) {
                    setFile(null); e.target.value = ""; setError(themeErrorMessage("too_large")); return;
                  }
                  setFile(picked);
                  setAttested(false);
                }} />
              </label>
              <p className="text-[11px] leading-relaxed text-muted">JPEG, PNG, GIF or WebP, up to 5 MB. Location metadata is removed; animated images become a still photo.</p>
              <label className="block space-y-1 text-xs font-semibold text-muted">
                <span>Caption and image description (optional)</span>
                <textarea className="ff-input min-h-20 w-full resize-y" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={CAPTION_MAX} placeholder="Describe what’s in the photo" data-testid="theme-photo-caption" aria-describedby={`${id}-caption-hint`} />
              </label>
              <p id={`${id}-caption-hint`} className="text-[11px] text-muted">Up to {CAPTION_MAX} characters. A short description also helps people who use screen readers.</p>
              <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-ink">
                <input type="checkbox" required={view.sfwRequired} checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-text)]" data-testid="theme-photo-sfw" />
                <span>I confirm this photo is safe for work and I have permission to share it publicly.</span>
              </label>
              <button type="submit" className={secondary} disabled={!file || (view.sfwRequired && !attested)} data-testid="theme-photo-upload">{busy === "Uploading photo…" ? busy : "Upload photo"}</button>
            </fieldset>
            {view.media.length >= view.maxMedia && <p className="text-xs text-muted">Your gallery is full. Remove a photo to make room.</p>}
          </form>}
          {view.media.length > 0 ? <>
            <p className="text-xs text-muted">Drag the grip to reorder, or use the Move earlier and Move later buttons.</p>
            <ol aria-labelledby={`${id}-photos`} className="space-y-3" data-testid="theme-photo-list">
              {view.media.map((photo, index) => (
                <PhotoEditor
                  key={`${reload}:${photo.id}`}
                  photo={photo}
                  index={index}
                  count={view.media.length}
                  locked={locked}
                  isBackground={draft.bgMediaId === photo.id}
                  onCaption={saveCaption}
                  onRemove={remove}
                  onMove={(step) => reorder(photo.id, index + step)}
                  onDragStart={(e) => startDrag(e, photo.id)}
                  onDragEnd={() => { dragged.current = null; }}
                  onDragOver={(e) => { if (dragged.current && !locked) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(e) => { e.preventDefault(); const from = dragged.current; dragged.current = null; if (from && !locked) void reorder(from, index); }}
                />
              ))}
            </ol>
          </> : <p className="text-xs text-muted">Your gallery is empty. Photos appear below your creator note on fan links.</p>}
        </div>
        {!loading && !loadFailed && <button type="button" onClick={reloadSaved} disabled={busy !== null} className="min-h-11 text-xs text-muted underline underline-offset-4 hover:text-ink">Reload saved settings{dirty ? " and discard appearance changes" : ""}</button>}
      </>}
      <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted" data-testid="theme-status">{busy || notice}</p>
    </section>
  );
}

function PhotoEditor({ photo, index, count, locked, isBackground, onCaption, onRemove, onMove, onDragStart, onDragEnd, onDragOver, onDrop }: {
  photo: ThemeMedia; index: number; count: number; locked: boolean; isBackground: boolean;
  onCaption: (id: string, value: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onMove: (step: number) => Promise<void>;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDrop: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const [caption, setCaption] = useState(photo.caption ?? "");
  const [confirm, setConfirm] = useState(false);
  const id = useId();
  return (
    <li className="min-w-0 rounded-xl border border-line bg-base/40 p-3" onDragOver={onDragOver} onDrop={onDrop} data-testid="theme-photo-item" data-media-id={photo.id}>
      <div className="flex min-w-0 items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- public, processed gallery photo */}
        <img src={photo.url} alt={photo.caption || `Gallery photo ${index + 1}`} width={photo.width} height={photo.height} loading="lazy" className="h-24 w-20 shrink-0 rounded-lg border border-line object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink">Photo {index + 1} of {count}{isBackground && <span className="ml-2 text-muted">Background</span>}</p>
            <button type="button" draggable={!locked} disabled={locked} onDragStart={onDragStart} onDragEnd={onDragEnd} aria-label={`Drag photo ${index + 1} to reorder; keyboard users can use Move earlier or Move later`} className={`${secondary} cursor-grab px-3 active:cursor-grabbing`}><span aria-hidden="true">⠿</span></button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={locked || index === 0} onClick={() => void onMove(-1)} className={`${secondary} text-xs`} aria-label={`Move photo ${index + 1} earlier`}>Move earlier</button>
            <button type="button" disabled={locked || index === count - 1} onClick={() => void onMove(1)} className={`${secondary} text-xs`} aria-label={`Move photo ${index + 1} later`}>Move later</button>
          </div>
        </div>
      </div>
      <form className="mt-3 space-y-2" aria-label={`Edit photo ${index + 1} description`} onSubmit={(e) => { e.preventDefault(); void onCaption(photo.id, caption); }}>
        <label htmlFor={`${id}-caption`} className="block text-xs font-semibold text-muted">Caption and image description</label>
        <textarea id={`${id}-caption`} className="ff-input min-h-20 w-full resize-y" maxLength={CAPTION_MAX} disabled={locked} value={caption} onChange={(e) => setCaption(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={locked || normalizeCaption(caption) === photo.caption} className={`${secondary} text-xs`}>Save description</button>
          <button type="button" disabled={locked} className={`${danger} text-xs`} aria-describedby={confirm ? `${id}-remove` : undefined} onClick={() => confirm ? void onRemove(photo.id) : setConfirm(true)}>{confirm ? "Remove permanently" : "Remove photo"}</button>
          {confirm && <button type="button" disabled={locked} className={`${secondary} text-xs`} onClick={() => setConfirm(false)}>Keep photo</button>}
        </div>
        {confirm && <p id={`${id}-remove`} className="text-xs leading-relaxed text-muted">Remove this photo from your public gallery? If it is your background, your background will return to Glow.</p>}
      </form>
    </li>
  );
}
