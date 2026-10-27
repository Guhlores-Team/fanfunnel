import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms of Service · FanFunnel" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        FanFunnel lets creators run prize wheels for their fans. These terms cover fans who use a
        creator&rsquo;s spin link and creators who run wheels.
      </p>
      <h2>Who can play</h2>
      <p>You must be 18 or older. Each spin page asks you to confirm this before you play.</p>
      <h2>Spins and prizes</h2>
      <ul>
        <li>Spins are given to you by the creator. Every spin lands on a prize.</li>
        <li>
          Prizes are provided and fulfilled by the creator, not by FanFunnel. Delivery, timing and
          substitutions are up to the creator.
        </li>
        <li>
          Results are provably fair: each spin&rsquo;s outcome is committed before you spin and can
          be checked on its verify page.
        </li>
      </ul>
      <h2>Your link</h2>
      <p>
        Your spin link is personal. Anyone who has it can use your spins, so don&rsquo;t share it.
        You can pause your link at any time from the spin page.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Don&rsquo;t abuse, scrape or attack the service, and don&rsquo;t harass creators or other
        fans. Accounts and links can be suspended for misuse.
      </p>
    </LegalPage>
  );
}
