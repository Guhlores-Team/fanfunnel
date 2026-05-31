import { notFound } from "next/navigation";
import { getFanPass } from "@/lib/data";
import SpinClient from "@/components/SpinClient";

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

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-black px-4 py-10">
      <SpinClient pass={pass} />
      <footer className="mt-10 text-xs text-white/30">
        Powered by FanFunnel · every spin wins
      </footer>
    </main>
  );
}
