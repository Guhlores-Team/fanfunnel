import type { Metadata } from "next";
import LegalPage, { ContactEmail, type LegalSection } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy · FanFunnel",
  description: "What FanFunnel collects about creators and fans, why, and how to exercise your rights.",
};

const OP = LEGAL.operator;

// How people exercise access and deletion rights today: by email only. When the
// self-service "Download my data" / "Delete my data" controls ship, rewrite this
// block (and the matching summary line below) to point at them first.
function HowToRequest() {
  return (
    <p>
      To see, download, correct or delete your information, email <ContactEmail /> and say what you would
      like. There is no self-service download or delete button yet, so we handle every request by hand.
    </p>
  );
}

const SUMMARY = [
  <>
    We collect what it takes to run prize wheels: creators’ account and wheel details, the fan records
    creators keep, and the spins, wins and messages on each spin link.
  </>,
  <>
    Fans do not need an account. A fan is known to us by the name or handle the creator entered, plus
    anything the fan adds, such as a board name, wishlist or chat messages.
  </>,
  <>
    We never see card details, because no payments happen on {OP}.
  </>,
  <>
    We do not sell or share personal information for advertising. There are no ad trackers or analytics
    cookies.
  </>,
  <>
    We use a small number of providers to host and run the Service: Supabase, Vercel, Upstash and Resend.
  </>,
  <>
    You can ask to see, correct, delete or export your information by emailing <ContactEmail />.
  </>,
];

const SECTIONS: LegalSection[] = [
  {
    id: "who",
    title: "Who we are and what this covers",
    body: (
      <>
        <p>
          This policy explains how {OP} (“we”, “us”) handles personal information when you use the{" "}
          {LEGAL.product} website and app (the “Service”), whether you are a creator, a team member or a fan.
          You can contact us about anything here at <ContactEmail />.
        </p>
        <p>
          <strong>Our role.</strong> {OP} is responsible (the “controller”) for account, security and
          service data. Creators decide which fans to add and what to note about them, so for the fan records
          a creator keeps, the creator is also responsible for that information. We process it to provide the
          Service to the creator and to keep the Service safe. If you are a fan, you can contact either the
          creator or us about your information.
        </p>
      </>
    ),
  },
  {
    id: "collect",
    title: "What we collect",
    body: (
      <>
        <h3>From creators and team members</h3>
        <ul>
          <li>
            <strong>Account:</strong> email address, password (stored only in scrambled, hashed form by our
            sign-in provider) and display name.
          </li>
          <li>
            <strong>Access request:</strong> the creator name, main platform, profile links and social
            handles, audience size, country, how you heard about us and any notes you send so we can review
            your request.
          </li>
          <li>
            <strong>Profile and public page:</strong> avatar image, a note to fans, public page address,
            tagline, tip link, brand colour and automatic chat greeting and follow-up messages.
          </li>
          <li>
            <strong>Wheels and prizes:</strong> wheel titles and schedules, prize names, descriptions,
            emoji, images, rarity, odds weights, stock and what each prize costs you, plus saved templates,
            campaigns, spin packs, happy hours, message templates and webhook addresses.
          </li>
          <li>
            <strong>Settings:</strong> notification choices, home-screen icon choice, dismissed tips and
            similar preferences.
          </li>
          <li>
            <strong>Agencies:</strong> agency name, members and their roles, invitation email addresses and
            which creator accounts each member can work on.
          </li>
        </ul>

        <h3>About fans, entered by the creator</h3>
        <ul>
          <li>the name or handle the creator uses for you, and any private notes and tags they add;</li>
          <li>
            the spins they give you, any amount they note against those spins for their own records, and the
            campaign it belongs to;
          </li>
          <li>whether the creator has blocked you.</li>
        </ul>

        <h3>From fans</h3>
        <ul>
          <li>the date and time you confirmed you are 18 or older and agreed to the Terms;</li>
          <li>your leaderboard choice and, if you opt in, the board name you pick;</li>
          <li>prizes you add to your wishlist;</li>
          <li>chat messages between you and the creator;</li>
          <li>reports you send us about a creator;</li>
          <li>when you pause your own link.</li>
        </ul>

        <h3>Created as you use the Service</h3>
        <ul>
          <li>
            <strong>Spins and wins:</strong> each spin, the prize won, its rarity, its delivery status, the
            time, and counters such as your spin balance and spins since your last rare prize.
          </li>
          <li>
            <strong>Fairness records:</strong> for each spin, the committed secret value and its hash, the
            random value your browser contributed, a counter, the prizes and odds in play, and a share code
            for the spin’s share and verify pages.
          </li>
          <li>
            <strong>Referrals:</strong> if a creator uses referral bonuses, a referral code and which fan
            referred which.
          </li>
          <li>
            <strong>IP address:</strong> used to limit how many requests one connection can make, to protect
            against abuse. Rate-limit counters expire within an hour.
          </li>
          <li>
            <strong>Technical logs:</strong> our hosting provider keeps short-lived request logs, and we keep
            redacted technical error reports so we can find and fix problems. We design these reports to
            leave out passwords, spin links and message content.
          </li>
        </ul>

        <h3>What we do not collect</h3>
        <ul>
          <li>Payment card or bank details. No payments happen on {OP}.</li>
          <li>Precise location, contacts, camera or microphone access.</li>
          <li>ID documents. The age check is a confirmation you make, not an ID check.</li>
          <li>Advertising or cross-site tracking data.</li>
        </ul>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use it, and our legal bases",
    body: (
      <>
        <p>
          If you are in the European Economic Area or the UK, the law requires a legal basis for each use. We
          rely on these:
        </p>
        <ul>
          <li>
            <strong>To provide the Service</strong> (accounts, wheels, spins, prizes, chat, leaderboards,
            notifications): to perform our contract with creators, and our legitimate interest, shared with
            creators, in running the spin pages fans use.
          </li>
          <li>
            <strong>To review access requests</strong> and decide who can run wheels: steps before entering
            a contract, and our legitimate interest in keeping the platform safe.
          </li>
          <li>
            <strong>To keep results provably fair</strong> and keep a record of every spin: our legitimate
            interest in being able to prove results and settle disputes.
          </li>
          <li>
            <strong>To prevent abuse and keep the Service secure</strong> (rate limits, blocks, reports, age
            confirmation, error reports): our legitimate interests, and legal obligations where they apply.
          </li>
          <li>
            <strong>To show you on a leaderboard:</strong> your consent, which you can withdraw at any time by
            opting out on the spin page.
          </li>
          <li>
            <strong>To send account emails</strong> (sign-up, password and email-change messages): to perform
            our contract.
          </li>
          <li>
            <strong>To meet legal duties</strong> and respond to lawful requests: legal obligation.
          </li>
        </ul>
        <p>
          We do not use personal information for advertising, and we do not make decisions about you based
          only on automated processing that have legal or similarly significant effects. The spin result is
          chance-based and is not based on a profile of you.
        </p>
      </>
    ),
  },
  {
    id: "visibility",
    title: "Who can see what",
    body: (
      <ul>
        <li>
          <strong>Creators</strong> see their own fans’ records, spins, wins, wishlists and chats, and the team
          members a creator or agency adds can see what their role allows.
        </li>
        <li>
          <strong>The public</strong> can see a creator’s public page, any leaderboard (board names of fans
          who opted in, with spin and rare-win counts), the recent-wins ticker (board names of opted-in fans
          and the prize), and share and verify pages to anyone who has the link. Share and verify pages show
          the prize and the creator, never the fan.
        </li>
        <li>
          <strong>{OP} staff</strong> can access data when needed to provide support, review reports, keep
          the Service secure or meet legal duties.
        </li>
        <li>
          <strong>Other websites:</strong> if a creator uses a prize image or a link hosted elsewhere, your
          browser loads or opens it from that site, which can see your IP address.
        </li>
      </ul>
    ),
  },
  {
    id: "sharing",
    title: "Who we share it with",
    body: (
      <>
        <p>We share personal information only with:</p>
        <ul>
          <li>
            <strong>Service providers</strong> who process it for us under contract:
            <ul>
              <li>Supabase: database, sign-in and file storage (for example avatars);</li>
              <li>Vercel: website hosting and request logs;</li>
              <li>Upstash: short-lived rate-limit counters keyed to IP address or link;</li>
              <li>Resend: delivering account emails.</li>
            </ul>
          </li>
          <li>
            <strong>Webhooks a creator sets up:</strong> when a fan wins, we send the prize name, its rarity
            and the time to the address the creator chose. We do not include the fan’s name, handle or link.
          </li>
          <li>
            <strong>Authorities or others</strong> where the law requires it, or where needed to protect
            someone’s safety or rights, including reports of child sexual abuse material to the appropriate
            authorities.
          </li>
          <li>
            <strong>A buyer or successor</strong> if {OP} is reorganised or sold, who must keep protecting the
            information as this policy describes.
          </li>
        </ul>
        <p>
          <strong>We do not sell personal information, and we do not share it for cross-context behavioural
          advertising</strong>, as those terms are used in California law. There is no ad tracking on {OP}.
        </p>
      </>
    ),
  },
  {
    id: "storage",
    title: "Cookies and storage on your device",
    body: (
      <>
        <p>
          We use only what the Service needs to work. There are no advertising or analytics cookies, so there
          is no cookie banner.
        </p>
        <ul>
          <li>
            <strong>Sign-in cookies</strong> (creators and team members): keep you signed in and are removed
            when you sign out.
          </li>
          <li>
            <strong>“Not now” on the add-to-home-screen prompt</strong> (fans): remembers when you dismissed
            it, so it stays hidden for 14 days.
          </li>
          <li>
            <strong>Chat panel</strong> (fans): remembers whether the chat was open and which message you saw
            last, so unread messages are marked correctly.
          </li>
          <li>
            <strong>Reveal counter</strong> (fans): counts spins in the current browser tab to pace the win
            animations, and is cleared when the tab closes.
          </li>
          <li>
            <strong>Debug switch:</strong> a troubleshooting flag for the current tab, which only works for {OP}
            staff.
          </li>
          <li>
            <strong>Dashboard app</strong> (creators): an app helper (service worker) so the dashboard can be
            installed. It stores no pages or data.
          </li>
          <li>
            <strong>Browser notifications</strong> (creators): only if you allow them in your browser.
          </li>
        </ul>
        <p>
          Fan spin pages set no cookies. You can clear this storage at any time in your browser settings.
          Because we do not sell or share data, there is nothing for a Global Privacy Control signal to switch
          off, but we treat it as an opt-out request anyway.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <ul>
        <li>
          <strong>Creator accounts and everything in them</strong> (wheels, fans, spins, chats, settings): for
          as long as the account is open. When an account is deleted, its data is deleted with it.
        </li>
        <li>
          <strong>Fan records:</strong> until the creator deletes the fan, wipes their data or closes their
          account. Deleting a fan also deletes that fan’s links, spins, wins, wishlist and chats.
        </li>
        <li>
          <strong>Access requests and reports:</strong> for as long as the related creator account exists, so
          decisions can be reviewed.
        </li>
        <li>
          <strong>Rate-limit counters:</strong> expire automatically, within an hour at most.
        </li>
        <li>
          <strong>Hosting logs and error reports:</strong> for a short period, then deleted automatically.
        </li>
        <li>
          <strong>Backups:</strong> deleted data may stay in our providers’ backups until those backups expire
          on their regular schedule.
        </li>
        <li>
          We may keep specific information longer when the law requires it or to deal with a legal claim.
        </li>
      </ul>
    ),
  },
  {
    id: "security",
    title: "How we protect it",
    body: (
      <p>
        Data is encrypted in transit. Database access rules keep each creator’s data separate, privileged
        actions are checked on our server, spin links are long random codes, and spin pages are kept out of
        search engines. No system is perfectly secure, so please keep your
        password and spin links private and tell us at <ContactEmail /> if you think something is wrong.
      </p>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        {OP} is run from the United States, and our providers may store and process information in the
        United States and other countries. Those countries may not have the same data protection laws as
        yours. When we transfer personal information out of the EEA, the UK or Switzerland, we rely on
        safeguards such as the European Commission’s Standard Contractual Clauses (and the UK addendum) or
        an adequacy decision, such as the EU–US Data Privacy Framework where a provider is certified.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <h3>Everyone</h3>
        <p>
          Wherever you live, you can ask us to tell you what we hold about you, correct it, delete it or give
          you a copy. Fans can also stop appearing on a leaderboard at any time on the spin page, and pause
          their link.
        </p>
        <h3>EEA and UK</h3>
        <p>
          You have the right to access, correct, delete, restrict or object to our use of your personal data,
          to data portability, and to withdraw consent at any time (this does not affect what we did before).
          You can also complain to your local data protection authority, or in the UK to the Information
          Commissioner’s Office, though we would appreciate the chance to help first.
        </p>
        <h3>California and other US states</h3>
        <p>
          California residents have the right to know what personal information we collect, use and disclose;
          to delete it; to correct it; and to opt out of its sale or sharing. We do not sell or share personal
          information, and we do not use sensitive personal information for anything other than providing the
          Service. Residents of other states with privacy laws have similar rights, including to appeal a
          decision we make about a request. We will not treat you differently for using any of these rights.
        </p>
        <h3>How to make a request</h3>
        <HowToRequest />
        <ul>
          <li>You can also use someone you authorise to ask for you.</li>
          <li>
            We will check the request comes from you. Creators may need to write from their account email.
            Fans may need to tell us the creator’s name and details only you would know, such as your board
            name or a recent prize. Do not send us your full spin link unless we ask for it.
          </li>
          <li>
            We reply within one month (EEA and UK) or 45 days (US states), and will tell you if we need more
            time as the law allows.
          </li>
          <li>
            If we turn down a request, we will explain why. If you are in a US state that gives you a right to
            appeal, reply to our answer to appeal and we will review it.
          </li>
          <li>
            If you are a fan, we may pass your request to the creator who holds your record, or ask them to act
            on it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "age",
    title: "Adults only",
    body: (
      <p>
        {OP} is only for people aged {LEGAL.minimumAge} or older. We do not knowingly collect information about
        anyone younger. If you believe a minor is using the Service, tell us at <ContactEmail /> and we will
        delete their information.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We will post any update here and change the “Last updated” date. If a change is significant, we will
        let you know before it takes effect, for example in the creator dashboard, by email or on the spin
        page.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        For privacy questions and requests, email <ContactEmail />.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" summary={SUMMARY} sections={SECTIONS} />;
}
