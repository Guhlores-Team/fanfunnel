import assert from "node:assert/strict";
import { mock } from "node:test";

// A36: demo mode never pretends. A link-in-bio save is really kept (and shows
// on /c/<slug> and the fan page). The features the demo can't run (Autopilot,
// agencies, access-request review) answer "demo_only" / demo: true, and the
// UI says "Demo only", instead of ok-and-nothing or an "all caught up".
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const data = await import("./index");
  const { mockCreatePass } = await import("./mock");
  const { resetMockPublicProfile } = await import("./mockPublicProfile");
  resetMockPublicProfile();

  // Link-in-bio.
  const saved = await data.setMyPublicProfile({ slug: "Demo Star", tagline: "Spin with me", tipUrl: "example.com/tip", note: "Thanks for playing!" });
  check("demo save answers ok", "ok" in saved);
  const mine = await data.getMyPublicProfile();
  check("demo save is kept (normalized slug, tip link, tagline, note)", mine.slug === "demo-star" && mine.tipUrl === "https://example.com/tip" && mine.tagline === "Spin with me" && mine.note === "Thanks for playing!");
  const page = await data.getPublicProfileBySlug("demo-star");
  check("the public page shows the saved tagline and tip link", page?.profile.tagline === "Spin with me" && page?.tipUrl === "https://example.com/tip");
  const bad = await data.setMyPublicProfile({ avatarUrl: "javascript:alert(1)" });
  check("demo refuses a non-http avatar like the database path", "error" in bad && bad.error === "invalid_avatar_url");
  const pass = mockCreatePass("Parity Fan", 1);
  const view = await data.getFanPass(pass.token);
  check("the fan page shows the saved creator note", view?.creatorNote === "Thanks for playing!");
  check("a saved avatar shows on the public page", "ok" in await data.setMyPublicProfile({ avatarUrl: "https://example.com/me.png" })
    && (await data.getPublicProfileBySlug("demo-star"))?.profile.avatarUrl === "https://example.com/me.png");
  await data.setMyPublicProfile({ note: "" });
  check("a cleared note shows no note, not the sample", (await data.getFanPass(pass.token))?.creatorNote === null);
  resetMockPublicProfile();
  check("before any save the demo shows its sample note", /spin away/.test((await data.getFanPass(pass.token))?.creatorNote ?? ""));

  // Autopilot: no cards in the demo, and the route says why.
  check("demo Autopilot has no cards", (await data.getAutopilot()).length === 0);
  const dismissed = await data.dismissAutopilotCard("fulfil");
  check("dismissing in the demo is demo_only, not a silent ok", "error" in dismissed && dismissed.error === "demo_only");
  const { GET: autopilotGet } = await import("@/app/api/autopilot/route");
  const feed = await (await autopilotGet(new Request("http://localhost/api/autopilot"))).json();
  check("the Autopilot read says demo instead of 'all caught up'", Array.isArray(feed.cards) && feed.demo === true);

  // Not available in the demo: said, not faked.
  const org = await data.createOrg("Demo Agency");
  check("creating an agency in the demo is demo_only", "error" in org && org.error === "demo_only");
  const invite = await data.inviteOrgCreator("org", "a@example.com");
  check("agency actions in the demo are demo_only", "error" in invite && invite.error === "demo_only");
  const decide = await data.decideCreatorApplication("profile", "approved");
  check("deciding an access request in the demo is demo_only", "error" in decide && decide.error === "demo_only");
  const { GET: agencyGet } = await import("@/app/api/agency/route");
  const agency = await (await agencyGet(new Request("http://localhost/api/agency"))).json();
  check("the agency read says demo instead of 'no agency yet'", agency.org === null && agency.demo === true);

  console.log(`demo parity: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
