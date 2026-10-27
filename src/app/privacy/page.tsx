import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy · FanFunnel" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>This page describes what FanFunnel stores and why.</p>
      <h2>Fans</h2>
      <ul>
        <li>The name or handle the creator gave you, and your spin balance.</li>
        <li>Your spins, the prizes you won, and their fulfilment status.</li>
        <li>Messages you send the creator, and prizes you add to your wishlist.</li>
        <li>
          Whether you confirmed the age check, and whether you chose to appear on the
          creator&rsquo;s leaderboard (handle only; off unless you opt in).
        </li>
      </ul>
      <h2>Creators</h2>
      <ul>
        <li>Your email address, sign-in details and profile (display name, avatar, public page).</li>
        <li>Your wheels, prizes, fans, grants and settings.</li>
      </ul>
      <h2>Technical data</h2>
      <ul>
        <li>A sign-in cookie for creators, so you stay logged in.</li>
        <li>IP addresses, used briefly to rate-limit requests and prevent abuse.</li>
      </ul>
      <h2>Who processes it</h2>
      <p>
        FanFunnel is hosted on Vercel and stores data with Supabase. We don&rsquo;t sell your data.
      </p>
      <h2>Removing your data</h2>
      <p>
        Fans can ask the creator who sent their link to delete their record. Creators can delete
        fans and reset their account&rsquo;s data from the dashboard.
      </p>
    </LegalPage>
  );
}
