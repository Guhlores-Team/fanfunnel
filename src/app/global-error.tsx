"use client";

// Last-resort error boundary: renders when the root layout itself throws, so it
// must supply its own <html>/<body> and can't rely on the layout's fonts. Keeps
// the brand surface (imports globals.css) and offers a retry. Reassures fans
// that their spins/balance are safe — server state is authoritative, this is a
// render-time hiccup only.
import "./globals.css";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] flex flex-col bg-base text-ink antialiased">
        <main
          className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
          style={brandVars(DEFAULT_BRAND)}
        >
          <div className="relative z-[1] w-full max-w-md">
            <div className="card rounded-[1.75rem] p-8 text-center">
              <div className="text-5xl">😵‍💫</div>
              <h1 className="mt-4 text-xl font-extrabold text-ink">
                Something went sideways
              </h1>
              <p className="mt-3 text-sm text-muted text-pretty">
                A hiccup on our end interrupted this page. Your spins and balance
                are safe. Try again &mdash; and if it keeps happening, let your
                creator know.
              </p>
              <button
                onClick={() => reset()}
                className="btn-brand mt-6 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
              >
                Try again
              </button>
            </div>
          </div>
          <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
            Powered by FanFunnel
          </footer>
        </main>
      </body>
    </html>
  );
}
