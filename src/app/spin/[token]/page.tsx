import { notFound } from "next/navigation";
import { getFanPass } from "@/lib/data";
import SpinClient from "@/components/SpinClient";
import type { CSSProperties } from "react";

// Fan-facing page. The token in the URL is the fan's secret pass.
export const dynamic = "force-dynamic";

export default async function SpinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const pass = await getFanPass(token);
  if (!pass) notFound();

  // The creator's brand color drives the whole page — every fan page feels
  // like THEIRS, not FanFunnel's.
  const brand = pass.wheel.brandColor ?? "#ec4899";

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={{ "--brand": brand } as CSSProperties}
    >
      <div className="relative z-[1] flex w-full justify-center">
        <SpinClient pass={pass} />
      </div>
      <footer className="relative z-[1] mt-10 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel · every spin wins
      </footer>
    </main>
  );
}
