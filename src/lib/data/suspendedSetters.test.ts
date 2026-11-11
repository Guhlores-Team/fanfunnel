import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (WU-01, real mode): the own-row setters answer a suspended
// account with NO error and write nothing (set_public_profile,
// set_creator_note, set_chat_settings, set_leaderboard_enabled,
// set_pwa_icon_mode, and set_display_name from 0073). Unchecked, the
// dashboard would say "saved". Each data function must prove the session's
// standing first and answer "forbidden" without calling the setter:
//   - display name: the caller's own profiles.is_active (session read; an
//     unapproved applicant may still be renamed);
//   - the rest: a literal true from can_act_for(self, 'manage').

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const ME = "11111111-1111-4111-8111-111111111111";
let isActive: unknown = true;
let mayManage: unknown = true;
let profileReadFails = false;
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
let serviceClients = 0;

const session = {
  auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.test" } }, error: null }) },
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ name, args });
    if (name === "can_act_for") return { data: args.target_creator === ME && args.perm === "manage" ? mayManage : false, error: null };
    return { data: null, error: null };
  },
  from: (table: string) => ({
    select: () => ({
      eq: (_column: string, id: string) => ({
        maybeSingle: async () => {
          if (table !== "profiles" || id !== ME) throw new Error(`unexpected session read of ${table}`);
          return profileReadFails ? { data: null, error: { message: "boom" } } : { data: { is_active: isActive, chat_intro: "hi", chat_outro: "bye" }, error: null };
        },
      }),
    }),
  }),
};
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => session,
    createServiceClient: () => {
      serviceClients++;
      throw new Error("the service role must not be used by an own-row setter");
    },
  },
});

const setters = () => rpcs.filter((r) => r.name.startsWith("set_"));

async function main() {
  const { ownAccountActive, sessionMayManageSelf } = await import("@/lib/auth/ownStanding");
  const { setMyDisplayName } = await import("./account");
  const { setMyPublicProfile } = await import("./publicProfile");
  const { setChatSettings } = await import("./inbox");
  const { setLeaderboardEnabled } = await import("./boosts");
  const { setMyPwaIconMode } = await import("./pwa");

  // --- the two proofs ---
  check("own row is_active true → true", (await ownAccountActive(session, ME)) === true);
  isActive = false;
  check("own row is_active false → false", (await ownAccountActive(session, ME)) === false);
  for (const odd of ["true", 1, null, undefined]) {
    isActive = odd;
    check(`own row is_active ${JSON.stringify(odd)} → unknown (null), never true`, (await ownAccountActive(session, ME)) === null);
  }
  profileReadFails = true;
  check("a failed own-row read → unknown (null)", (await ownAccountActive(session, ME)) === null);
  profileReadFails = false;
  check("a client that throws → unknown (null)", (await ownAccountActive({ from: () => { throw new Error("down"); } }, ME)) === null);
  isActive = true;
  check("can_act_for true → may manage", (await sessionMayManageSelf(session, ME)) === true);
  for (const odd of [false, null, "true", 1]) {
    mayManage = odd;
    check(`can_act_for ${JSON.stringify(odd)} → refused`, (await sessionMayManageSelf(session, ME)) === false);
  }
  check("a permission read that errors → refused", (await sessionMayManageSelf({ rpc: async () => ({ data: true, error: { message: "boom" } }) }, ME)) === false);
  check("a permission read that throws → refused", (await sessionMayManageSelf({ rpc: async () => { throw new Error("down"); } }, ME)) === false);
  mayManage = true;

  // --- in good standing: each setter is reached ---
  rpcs.length = 0;
  check("active: display name saves", "ok" in (await setMyDisplayName("Ava")));
  check("active: public profile saves", "ok" in (await setMyPublicProfile({ tagline: "hello", note: "hey" })));
  check("active: chat settings save", "ok" in (await setChatSettings({ intro: "hi", outro: "bye" })));
  check("active: leaderboard switch saves", "ok" in (await setLeaderboardEnabled(true)));
  check("active: icon mode saves", "ok" in (await setMyPwaIconMode("avatar")));
  const reached = new Set(setters().map((r) => r.name));
  check("…through each own-row setter", ["set_display_name", "set_public_profile", "set_creator_note", "set_chat_settings", "set_leaderboard_enabled", "set_pwa_icon_mode"].every((n) => reached.has(n)));

  // --- suspended: refused, and the setter is never called ---
  isActive = false;
  mayManage = false;
  rpcs.length = 0;
  const refused = async (label: string, run: () => Promise<unknown>) => {
    const out = (await run()) as { error?: string; ok?: true };
    check(`suspended: ${label} → forbidden, not "saved"`, out.error === "forbidden" && !("ok" in out));
  };
  await refused("display name", () => setMyDisplayName("Ava"));
  await refused("public page (slug, tagline, tip link)", () => setMyPublicProfile({ slug: "ava", tagline: "hello", tipUrl: "https://example.com/tip" }));
  await refused("creator note and photo", () => setMyPublicProfile({ note: "hey", avatarUrl: "" }));
  await refused("delivery promise", () => setMyPublicProfile({ deliveryDays: 7 }));
  await refused("auto-messages", () => setChatSettings({ intro: "hi", outro: "bye" }));
  await refused("leaderboard switch", () => setLeaderboardEnabled(true));
  await refused("home-screen icon", () => setMyPwaIconMode("avatar"));
  check("no setter RPC was called for a suspended account", setters().length === 0);
  check("the service role was never touched", serviceClients === 0);

  // An unapproved applicant (is_active true, can_act_for false) may still be renamed.
  isActive = true;
  rpcs.length = 0;
  check("unapproved but not suspended: display name still saves", "ok" in (await setMyDisplayName("Ava")) && setters().length === 1 && setters()[0].name === "set_display_name");
  await refused("an unapproved account's public page", () => setMyPublicProfile({ tagline: "hello" }));
  profileReadFails = true;
  const unknown = (await setMyDisplayName("Ava")) as { error?: string };
  check("standing unknown → db_error, never a silent save", unknown.error === "db_error" && setters().length === 1);
  profileReadFails = false;

  console.log(`suspended setters: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
