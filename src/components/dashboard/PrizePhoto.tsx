"use client";

import { useRef, useState } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";

/**
 * Upload a real photo for a prize, shown in the win modal + public share card.
 * Live mode uploads to the public `prize-photos` bucket (namespaced under the
 * creator's uid, per the storage RLS policy). Demo mode keeps a local data URL
 * so the editor works before any Supabase is connected.
 */
export default function PrizePhoto({
  imageUrl,
  onChange,
}: {
  imageUrl?: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Pick an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast("Image must be under 5 MB");
      return;
    }
    void upload(file);
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      if (!isSupabaseConfigured()) {
        // Demo: inline data URL.
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        onChange(url);
        return;
      }
      const sb = createClient();
      const { data: auth } = await sb.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) {
        toast("Sign in to upload");
        return;
      }
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage
        .from("prize-photos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) {
        toast("Upload failed");
        return;
      }
      const { data } = sb.storage.from("prize-photos").getPublicUrl(path);
      onChange(data.publicUrl);
    } catch {
      toast("Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={pick}
        className="hidden"
      />
      {imageUrl ? (
        <span className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Prize"
            className="h-14 w-14 rounded-lg border border-line object-cover"
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-base text-xs text-muted ring-1 ring-line transition hover:text-red-400"
            aria-label="Remove photo"
            title="Remove photo"
          >
            ✕
          </button>
        </span>
      ) : (
        <span className="grid h-14 w-14 place-items-center rounded-lg border border-dashed border-line text-lg text-muted">
          🖼️
        </span>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-[var(--brand)] disabled:opacity-50"
      >
        {busy ? "Uploading…" : imageUrl ? "Replace photo" : "Add photo"}
      </button>
    </div>
  );
}
