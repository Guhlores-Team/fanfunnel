import type { Metadata } from "next";
import LegalPage, { ContactEmail, type LegalSection } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service · FanFunnel",
  description: "The rules for creators and fans using FanFunnel prize wheels.",
};

const OP = LEGAL.operator;
const AGE = LEGAL.minimumAge;

const SUMMARY = [
  <>
    {OP} is software that lets creators run prize wheels for their fans. You must be {AGE} or older to
    use it.
  </>,
  <>
    {OP} does not take payments. Tips and purchases happen on the creator’s own platforms and links, and
    the creator, not {OP}, decides who gets spins.
  </>,
  <>
    Creators supply and deliver every prize. {OP} is not part of the deal between a creator and a fan
    and is not responsible for prizes.
  </>,
  <>
    Every result is decided on our server from a value committed before you spin, and anyone can check
    it on the spin’s public verify page.
  </>,
  <>
    Leaderboards are off unless the creator turns them on and you opt in. Share cards never show who you
    are.
  </>,
  <>
    Creators must keep their content and prizes lawful, describe prizes accurately and never mislead fans
    about the odds.
  </>,
  <>
    {OP} never charges fans and is free for creators today. If we ever introduce creator fees, or make a
    material change to these terms, we will give at least {LEGAL.changeNoticeDays} days’ notice first.
  </>,
  <>
    These terms are governed by the law of Massachusetts, USA. Questions:{" "}
    <ContactEmail />.
  </>,
];

const SECTIONS: LegalSection[] = [
  {
    id: "about",
    title: "About these terms",
    body: (
      <>
        <p>
          These Terms of Service (“Terms”) are an agreement between you and {OP} (“{OP}”, “we”, “us”). They
          apply to everyone who uses the {LEGAL.product} website and app (the “Service”):
        </p>
        <ul>
          <li>
            <strong>Creators</strong>, who sign up for an account and run prize wheels;
          </li>
          <li>
            <strong>Team members</strong>, who use a creator’s or agency’s account with the access they
            were given; and
          </li>
          <li>
            <strong>Fans</strong>, who open a spin link a creator sent them.
          </li>
        </ul>
        <p>
          By using the Service, or by ticking “I agree” when you sign up, request access or open a spin page,
          you agree to these Terms. We record when you agreed and which version you agreed to. If you do not
          agree, do not use the Service. Our <a href="/privacy">Privacy Policy</a> explains how we
          handle personal information and forms part of these Terms.
        </p>
      </>
    ),
  },
  {
    id: "what-it-is",
    title: "What FanFunnel is, and what it is not",
    body: (
      <>
        <p>
          {OP} is a tool. A creator builds a wheel of prizes, sets how likely each prize is, and sends fans
          personal spin links. A fan spins with the spins the creator has given them, lands on a prize, and
          the creator then delivers that prize.
        </p>
        <ul>
          <li>
            <strong>We do not process payments.</strong> No money changes hands on {OP}. If a creator
            invites you to tip them or buy anything, that happens on the creator’s own platform or link,
            under that platform’s terms.
          </li>
          <li>
            <strong>We are not a party to creator–fan dealings.</strong> Any promise, sale, tip, prize or
            refund is between the creator and the fan.
          </li>
          <li>
            <strong>We do not supply prizes.</strong> We do not own, check, store, ship or guarantee them.
          </li>
          <li>
            <strong>Spins have no cash value.</strong> A spin cannot be exchanged for money, cashed out,
            sold or transferred, and {OP} will never pay out money to fans.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Who can use FanFunnel",
    body: (
      <>
        <p>
          You must be at least {AGE} years old, and an adult under the law where you live if that age is
          higher. Every spin page asks fans to confirm this before they play, and we record when you
          confirmed it. Do not use the Service if you are under that age, or where using it would be
          against the law where you are.
        </p>
        <p>
          Creator accounts need our approval. We review each access request and may decline one for any
          lawful reason. We may ask for more information to confirm who you are.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and spin links",
    body: (
      <>
        <h3>Creators and team members</h3>
        <p>
          Give us accurate information, keep your password private and tell us straight away at{" "}
          <ContactEmail /> if you think someone else has got into your account. You are responsible for
          what happens under your account, including what team members you add do with the access you give
          them.
        </p>
        <h3>Fans</h3>
        <p>
          Fans do not need an account. Your spin link is the key to your spins, wins and messages with that
          creator. Anyone who has your link can use it, so do not share it. You can pause your link at any
          time from the spin page, and the creator can send you a new one.
        </p>
      </>
    ),
  },
  {
    id: "spins-prizes",
    title: "How spins and prizes work",
    body: (
      <>
        <ul>
          <li>
            <strong>Creators grant spins.</strong> Only the creator decides when to give a fan spins and
            how many, for example as a thank-you, as part of a campaign, as a referral bonus or as a bonus
            with a pack. {OP} does not sell spins.
          </li>
          <li>
            <strong>Every spin lands on a prize</strong> from the creator’s wheel. Prizes are labelled with
            a rarity (common to legendary).
          </li>
          <li>
            <strong>Odds are set by the creator</strong>, by giving each prize a weight. The odds can also
            change for a time, for example during a creator’s “happy hour” (which makes rare prizes more
            likely), when a limited prize runs out, or through the guarantee of a rare prize after a run of
            spins without one. Each spin’s verify page shows the odds that applied to it.
          </li>
          <li>
            <strong>Creators supply and deliver prizes.</strong> When and how a prize is delivered, and any
            substitute, is up to the creator. If a creator does not deliver, take it up with the creator.
            You can also report a creator to us from the spin page.
          </li>
          <li>
            <strong>Spins can end.</strong> A creator can block a link, and spins can be lost if the
            creator’s wheel or account is closed or if these Terms are broken. Unused spins are not
            refundable by {OP}.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "payments",
    title: "Payments happen off FanFunnel",
    body: (
      <>
        <p>
          A creator may show a tip or purchase link on their spin page or public page. Those links lead to
          other services that {OP} does not run or control. Any payment, subscription, refund or chargeback
          is between you, the creator and that service, under its terms.
        </p>
        <p>
          Creators can record amounts next to the spins they grant, for their own bookkeeping. That record
          is not a payment, a receipt or proof of purchase, and we do not check it.
        </p>
      </>
    ),
  },
  {
    id: "fairness",
    title: "Provably fair results",
    body: (
      <>
        <p>
          Every result is decided on our server, never in your browser. Before you spin, the Service commits
          to a secret value by showing you its fingerprint (a cryptographic hash). Your browser adds its own
          random value, and the result is worked out from both together with the prizes and odds in play at
          that moment.
        </p>
        <p>
          After the spin, its public verify page reveals the secret value so anyone can confirm that it
          matches the fingerprint shown beforehand and that it leads to the prize that was won. The verify
          page shows the prize, its rarity, the odds used and the fairness data. It does not show who spun.
        </p>
        <p>
          The verify page proves how a result was picked. It does not prove what a prize is worth or that
          it was delivered. Some older spins were made before every check was recorded and may verify only
          in part.
        </p>
      </>
    ),
  },
  {
    id: "public-features",
    title: "Leaderboards, recent wins and share cards",
    body: (
      <>
        <ul>
          <li>
            <strong>Leaderboards are opt-in.</strong> A creator has to switch on their leaderboard, and
            then each fan chooses whether to appear on it under a board name they pick. The board shows that
            name, the number of spins and the number of rare wins. It never shows your real name or what you
            have spent. Fans who opt in may also appear by board name in the creator’s recent-wins ticker.
            You can opt out at any time on the spin page.
          </li>
          <li>
            <strong>Share cards are yours to share.</strong> Each win has a share page showing the prize,
            its rarity, the creator’s name and the date, with no fan details. Anyone with the share link can
            see it, so share it only if you want to.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "creator-rules",
    title: "What creators agree to",
    body: (
      <>
        <p>If you run wheels on {OP}, you agree that:</p>
        <ul>
          <li>
            <strong>Your content and prizes are lawful</strong> wherever you offer them, and you have every
            right, licence and consent needed for anything you upload or offer, including images of other
            people.
          </li>
          <li>
            <strong>Your promotion is your responsibility.</strong> You are responsible for running your
            wheels, spin offers, tips and prizes in line with the laws that apply to you and your fans,
            including laws on lotteries, sweepstakes, contests and promotions, consumer protection, tax and
            age-restricted content. {OP} does not give legal advice.
          </li>
          <li>
            <strong>You follow your platforms’ rules.</strong> Using {OP} alongside another platform (for
            example where you take tips) does not excuse you from that platform’s terms.
          </li>
          <li>
            <strong>You describe prizes accurately</strong>, including what a prize is, any limits, and how
            and when you will deliver it.
          </li>
          <li>
            <strong>You never mislead fans about the odds.</strong> Do not claim a prize is more likely than
            your settings make it, and do not advertise prizes you have no intention of delivering.
          </li>
          <li>
            <strong>You deliver what fans win</strong>, within a reasonable time, or tell the fan promptly
            and offer a fair substitute.
          </li>
          <li>
            <strong>You only deal with adults.</strong> Never send a spin link to anyone you know or suspect
            is under {AGE}.
          </li>
          <li>
            <strong>You handle fan information lawfully.</strong> Only record information about fans that you
            are allowed to, keep notes respectful, and honour fans’ requests about their information (see our
            Privacy Policy).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "prohibited",
    title: "Things nobody may do",
    body: (
      <>
        <p>Whether you are a creator, team member or fan, do not use the Service to:</p>
        <ul>
          <li>break the law, or help anyone else break it;</li>
          <li>involve anyone under {AGE}, or share any sexual content involving a minor;</li>
          <li>share content without the consent of the people in it, or that you have no right to share;</li>
          <li>harass, threaten, exploit, defraud or impersonate anyone;</li>
          <li>send spam or unwanted messages through chat or webhooks;</li>
          <li>
            scrape the Service, spin automatically, get around rate limits, blocks or a paused link, or try
            to predict or tamper with results;
          </li>
          <li>
            attack, probe or overload the Service, or reach data or accounts that are not yours;
          </li>
          <li>sell, rent or transfer an account or spin link; or</li>
          <li>upload malware or anything designed to harm devices or data.</li>
        </ul>
      </>
    ),
  },
  {
    id: "content",
    title: "Your content and our licence to use it",
    body: (
      <>
        <p>
          You keep ownership of what you put on {OP}: for creators, things like your wheels, prize
          descriptions, images, avatar, public page and messages; for fans, things like your board name,
          wishlist and messages.
        </p>
        <p>
          You give {OP} a worldwide, non-exclusive, royalty-free licence to host, store, copy, resize, format
          and display that content only as needed to run, secure and improve the Service and to show it
          where you have set it to appear (for example your spin page, public page, leaderboard, share
          cards and verify pages). This licence ends when the content is deleted, except for copies already
          shared by others, copies in backups until they expire, and copies we must keep by law.
        </p>
        <p>
          If you send us feedback or ideas, we may use them without owing you anything. The Service itself,
          including its design, code and the {LEGAL.product} name, belongs to {OP}.
        </p>
      </>
    ),
  },
  {
    id: "copyright",
    title: "Copyright and takedown requests",
    body: (
      <>
        <p>
          If you believe something on {OP} infringes your copyright or other rights, email <ContactEmail />{" "}
          with:
        </p>
        <ul>
          <li>your name and contact details;</li>
          <li>what you own and what on {OP} infringes it, with a link or enough detail to find it;</li>
          <li>a statement that you believe in good faith the use is not authorised by you, your agent or the law;</li>
          <li>
            a statement that your notice is accurate and, under penalty of perjury, that you are the owner or
            authorised to act for the owner; and
          </li>
          <li>your physical or electronic signature.</li>
        </ul>
        <p>
          We will remove or disable material where appropriate and tell the person who posted it. If your
          material was removed and you believe that was a mistake, you can send a counter-notice to the same
          address. We close the accounts of people who repeatedly infringe.
        </p>
        <p>
          You can also use this address to report non-consensual intimate images or any content involving a
          minor. We treat those reports as urgent.
        </p>
      </>
    ),
  },
  {
    id: "safety",
    title: "Reports, pausing and blocking",
    body: (
      <ul>
        <li>Fans can report a creator from the spin page. We review reports and may act on them.</li>
        <li>
          Fans can pause their own link at any time. A paused link stops working, and the creator can send a
          new one if the fan asks.
        </li>
        <li>Creators can block a fan, which stops that fan’s links working.</li>
      </ul>
    ),
  },
  {
    id: "termination",
    title: "Suspending or closing accounts",
    body: (
      <>
        <p>
          <strong>You can stop at any time.</strong> Creators can ask us to delete their account by emailing{" "}
          <ContactEmail />, and can wipe their wheels and fan data from the dashboard. Fans can pause their
          link and ask the creator or us to delete their information.
        </p>
        <p>
          <strong>We can suspend or close access</strong>, to an account, a wheel or a spin link, if we
          reasonably believe these Terms or the law have been broken, if someone is at risk, or if we are
          required to. Where it is safe and lawful, we will tell you why.
        </p>
        <p>
          When access ends, spin links stop working and unused spins are lost. A creator stays responsible
          for prizes fans won before then. Sections that by their nature should continue (such as content
          licences already used, disclaimers, limits of liability, indemnity and governing law) continue
          after these Terms end.
        </p>
      </>
    ),
  },
  {
    id: "changes-service",
    title: "Changes to the Service and fees",
    body: (
      <p>
        We are improving {OP} all the time, so features may change, be added or be removed. {OP} never
        charges fans. {OP} is free for creators today. If we introduce creator fees, we will tell creators at
        least {LEGAL.changeNoticeDays} days before any fee applies, and nobody will be charged without agreeing
        first.
      </p>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <>
        <p>
          The Service is provided “as is” and “as available”. To the fullest extent the law allows, we make no
          promises beyond those written in these Terms, including about uptime, about the Service being
          error-free, or about any creator, prize, content or external link.
        </p>
        <p>
          We do not check creators’ prizes, offers or content, and we are not responsible for whether a
          creator delivers a prize, what it is worth, or anything that happens between a creator and a fan.
        </p>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <p>
          To the fullest extent the law allows, {OP} will not be liable for indirect, incidental, special,
          consequential or punitive losses, or for lost profits, revenue, data or goodwill. Our total
          liability for any claim about the Service is limited to the greater of the amount you paid {OP} in
          the 12 months before the claim and US$100.
        </p>
        <p>
          Nothing in these Terms limits liability that cannot be limited by law, such as for fraud, or for
          death or personal injury caused by negligence. If you are a consumer in the EU, the UK or another
          place whose laws give you rights that cannot be waived, these Terms do not take those rights away.
        </p>
      </>
    ),
  },
  {
    id: "indemnity",
    title: "Your responsibility for claims",
    body: (
      <p>
        If you are a creator or team member, you agree to cover {OP}’s reasonable costs and losses
        (including legal fees) from claims by others that arise from your content, your prizes, your dealings
        with fans or your breach of these Terms or the law. This applies to the extent the law allows.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    body: (
      <>
        <p>
          These Terms are governed by the law of {LEGAL.governingLaw}, without regard to its conflict-of-law
          rules. Any dispute about the Service or these Terms will be heard in {LEGAL.venue}, and you and {OP}
          agree to those courts’ jurisdiction.
        </p>
        <p>
          If you are a consumer living in the EU or the UK, you also keep the protection of the mandatory
          laws of the country where you live, and you may bring a claim in your local courts.
        </p>
        <p>
          Before starting a formal dispute, please email <ContactEmail /> so we can try to sort it out.
        </p>
      </>
    ),
  },
  {
    id: "changes-terms",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these Terms. When we do, we will post the new version here and change the “Last
        updated” date. If a change is material, we will give at least {LEGAL.changeNoticeDays} days’ notice
        before it takes effect: by email to creators, and with a notice in the app or on this page for fans.
        A change required by law, or needed to keep the Service secure, may take effect sooner. We may ask
        you to agree to the new version before you continue. If you keep using the Service after a change
        takes effect, the updated Terms apply. If you do not agree, stop using the Service.
      </p>
    ),
  },
  {
    id: "general",
    title: "General",
    body: (
      <ul>
        <li>These Terms and the Privacy Policy are the whole agreement between you and {OP} about the Service.</li>
        <li>If part of these Terms cannot be enforced, the rest still applies.</li>
        <li>If we do not enforce a right straight away, we have not given it up.</li>
        <li>
          You may not transfer your rights under these Terms. We may transfer ours, for example if {OP} is
          reorganised or sold, and the Terms will continue to protect you.
        </li>
        <li>We are not responsible for delays or failures caused by events outside our reasonable control.</li>
      </ul>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these Terms, copyright notices and legal requests go to <ContactEmail />.
      </p>
    ),
  },
];

export default function TermsPage() {
  return <LegalPage title="Terms of Service" summary={SUMMARY} sections={SECTIONS} />;
}
