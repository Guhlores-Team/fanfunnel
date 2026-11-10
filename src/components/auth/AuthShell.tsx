import Link from "next/link";

/** The sign-in family's page frame: centred card column with the wordmark. */
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-black px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-6 block text-center text-2xl font-extrabold text-white">
          🎡 FanFunnel
        </Link>
        {children}
      </div>
    </main>
  );
}
