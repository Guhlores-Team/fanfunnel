import type { FanLinkStatus } from "@/lib/data";

/**
 * What a fan link shows when it stopped working for a reason the fan should
 * know, instead of a bare 404. Both come from link_tombstones, which keeps
 * only a SHA-256 hash of the token and the reason, never who the fan was.
 */
const COPY: Record<FanLinkStatus, { title: string; body: string }> = {
  creator_closed: {
    title: "This creator has left FanFunnel",
    body: "They closed their account, so this link doesn't work any more and the data behind it has been deleted. Thanks for playing.",
  },
  fan_deleted: {
    title: "This link was deleted",
    body: "You deleted your data, so this link doesn't work any more. If you want to play again, ask the creator for a new link.",
  },
};

export default function LinkGone({ status }: { status: FanLinkStatus }) {
  const copy = COPY[status];
  return (
    <main className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center overflow-x-clip px-5 py-10">
      <div className="card relative z-[1] w-full max-w-sm rounded-2xl p-6 text-center">
        <span aria-hidden="true" className="text-3xl">
          {status === "creator_closed" ? "👋" : "🗑️"}
        </span>
        <h1 className="mt-3 text-lg font-bold text-ink">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted">{copy.body}</p>
      </div>
      <p className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">Powered by FanFunnel</p>
    </main>
  );
}
