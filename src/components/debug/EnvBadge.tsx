import { envLabel } from "@/lib/envLabel";

// Preview-only strip naming the database this build uses. Mounted under the same
// NEXT_PUBLIC_ENABLE_DEBUG gate as the error console, so it never ships to
// production. pointer-events-none: it must never block a click. Below lg it
// sits on top of the phone tab bar instead of over the page title.
export default function EnvBadge() {
  const { text, tone } = envLabel(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const colors =
    tone === "danger"
      ? "bg-[#dc2626] text-white"
      : tone === "ok"
        ? "bg-[#0e7490] text-white"
        : "bg-[#3f3f46] text-white";
  return (
    <div
      role="note"
      data-env-badge={tone}
      className={`pointer-events-none fixed bottom-[var(--ff-bottom-offset,0px)] left-1/2 z-[100] -translate-x-1/2 max-w-[calc(100vw-1rem)] truncate rounded-t-md lg:bottom-auto lg:top-0 lg:rounded-b-md lg:rounded-t-none px-2.5 py-0.5 font-sans text-[10px] font-bold uppercase tracking-[0.08em] shadow ${colors}`}
    >
      {text}
    </div>
  );
}
