import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-white">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-24 text-center">
        <span className="rounded-full bg-pink-500/15 px-4 py-1.5 text-sm font-semibold text-pink-300">
          🎡 Creator engagement games
        </span>
        <h1 className="mt-6 text-5xl font-extrabold tracking-tight sm:text-6xl">
          FanFunnel
        </h1>
        <p className="mt-4 max-w-xl text-lg text-white/70">
          Send each fan a personal prize wheel. They tip, you grant spins, every
          spin wins — and the rare drops keep them coming back.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/spin/demo"
            className="rounded-2xl bg-pink-500 px-7 py-3.5 text-lg font-bold shadow-lg transition hover:bg-pink-400"
          >
            Try the demo wheel →
          </Link>
          <Link
            href="/dashboard"
            className="rounded-2xl border border-white/15 px-7 py-3.5 text-lg font-bold transition hover:bg-white/5"
          >
            Creator dashboard
          </Link>
        </div>

        <div className="mt-20 grid gap-6 sm:grid-cols-3">
          {[
            {
              t: "Unique fan links",
              d: "Every fan gets their own link with their own spin balance.",
            },
            {
              t: "You control the odds",
              d: "Set prizes, rarity and limited stock. Rare = irresistible.",
            },
            {
              t: "No gambling, no fees",
              d: "Fans tip on-platform; every spin wins a guaranteed reward.",
            },
          ].map((f) => (
            <div
              key={f.t}
              className="rounded-2xl border border-white/10 bg-white/5 p-6 text-left"
            >
              <h3 className="font-bold text-pink-300">{f.t}</h3>
              <p className="mt-2 text-sm text-white/60">{f.d}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
