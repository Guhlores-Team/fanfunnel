import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables, eqValue } from "@/lib/privacy/fakeTables";
import { EXPORT_ROW_CAP, exportDownloadWarning } from "@/lib/privacy/exportRecords";

// Causal coverage for previously silent PostgREST limits, missing operational
// records, query failures and credential leakage. The fake enforces a real
// page limit and sorts before slicing, rather than returning unlimited rows.
const CA = "c0000000-0000-4000-8000-00000000000a";
const CB = "c0000000-0000-4000-8000-00000000000b";
const FAN = "fan-own", OTHER = "fan-other", TOKEN = "export-owner-token-12345678";
const at = "2026-10-01T00:00:00.000Z";
const many = (count: number, make: (id: string) => Record<string, unknown>) => Array.from({ length: count }, (_, index) => make(String(count - index).padStart(6, "0")));
const owned = (id: string) => ({ id, fan_id: FAN, creator_id: CA, created_at: at });
const material = { cipher: "REWARD-CIPHER", iv: "REWARD-IV", fingerprint: "REWARD-FINGERPRINT", hint: "REWARD-HINT", key_version: "REWARD-KEY-VERSION", value: "REDEEMABLE-SECRET" };
const svc = new FakeTables({
  profiles: [{ id: CA, display_name: "Owner" }],
  fans: [{ id: FAN, creator_id: CA, display_name: "Fan", handle: "fan", spins_remaining: 2, spins_granted_total: 7, break_until: "2026-11-01T00:00:00Z", referred_by_fan_id: null, notes: "PRIVATE-NOTES", tags: ["PRIVATE-TAGS"] }],
  fan_passes: [{ id: "000000", token: TOKEN, fan_id: FAN, creator_id: CA, is_active: true }, ...many(2000, (id) => ({ ...owned(id), token: `OTHER-OWN-LINK-${id}`, next_server_seed: "NEXT-SEED-SECRET", is_active: true })), { id: "foreign", token: "FOREIGN-TOKEN", fan_id: OTHER, creator_id: CA }],
  grants: [...many(2001, (id) => ({ ...owned(id), spins: 1, bonus_spins: 0, amount_cents: 982341 })), { ...owned("bad-grant"), fan_id: OTHER, spins: 999 }, { ...owned("wrong-tenant"), creator_id: CB, spins: 999 }],
  messages: [...many(2001, (id) => ({ ...owned(id), sender: "fan", body: `Own message ${id}` })), { ...owned("wrong-fan"), fan_id: OTHER, sender: "fan", body: "UNRELATED-MESSAGE" }, { ...owned("private-reply"), sender: "creator", body: "CREATOR-REPLY" }],
  wishlists: many(2001, (id) => ({ ...owned(id), prize_label: `Wish ${id}`, prize_rarity: "common" })),
  spins: many(2001, (id) => ({ ...owned(id), prize_label: `Win ${id}`, prize_rarity: "common", server_seed: "spent-seed", pool_snapshot: { prizes: [{ label: "Public", cost_cents: 982341, notes: "SNAPSHOT-PRIVATE" }], cipher: "CIPHER-SECRET" } })),
  redemptions: many(2001, (id) => ({ id, spin_id: id, creator_id: CA, status: "fulfilled", created_at: at, notes: "PRIVATE-DELIVERY-NOTES", due_at: "PRIVATE-DUE-DATE" })),
  spin_rewards: [...many(2001, (id) => ({ spin_id: id, creator_id: CA, kind: "code", views: 3, last_viewed_at: at, created_at: at, erased_at: id === "000001" ? at : null, ...material })), { spin_id: "foreign-fan-spin", creator_id: CA, kind: "FOREIGN-RECEIPT" }, { spin_id: "000001", creator_id: CB, kind: "FOREIGN-TENANT-RECEIPT" }],
  fan_play_reminders: [{ fan_id: FAN, daily: 50, updated_at: at }, { fan_id: OTHER, daily: 100, updated_at: at }],
  fan_checkins: [{ ...owned("check-own"), day: "2026-10-01" }, { ...owned("check-other"), fan_id: OTHER, day: "2026-10-02" }],
  fan_outreach: [{ ...owned("contact-own"), contacted_at: at, snoozed_until: "PRIVATE-SNOOZE", template_id: "PRIVATE-TEMPLATE" }, { ...owned("contact-other"), fan_id: OTHER, contacted_at: "UNRELATED-CONTACT" }],
  creator_reports: [{ ...owned("report-own"), token: TOKEN, reason: "safety", detail: "My report" }, { ...owned("report-other"), fan_id: OTHER, reason: "other", detail: "UNRELATED-REPORT" }],
  referrals: [],
});
const session = new FakeTables({
  profiles: [{ id: CA, display_name: "Owner", secret: "PROFILE-SECRET", theme: { font: "syne", background: "noir", url: "THEME-SECRET-URL", nested: { cipher: "THEME-SECRET-CIPHER" } } }],
  creator_media: [...many(2001, (id) => ({ id, creator_id: CA, caption: `Photo ${id}`, width: 10, height: 20, sort_order: Number(id), sfw_attested_at: at, created_at: at, path: "PHOTO-INTERNAL-PATH", url: "PHOTO-SIGNED-URL", webp: "PHOTO-BYTES" })), { id: "other-photo", creator_id: CB, caption: "TENANT-B-BUSINESS" }],
  creator_storage_dispatches: [{ id: "dispatch-own", owner_id: CA, kind: "remove", state: "uncertain", worker_id: "WORK-DISPATCH-WORKER", attempt_id: "WORK-DISPATCH-ATTEMPT" }, { id: "dispatch-other", owner_id: CB, state: "TENANT-B-BUSINESS" }],
  creator_storage_objects: [{ id: "object-own", owner_id: CA, bucket: "avatars", path: `${CA}/photo.webp`, upload_state: "uncertain", cleanup_kind: "orphan", last_error: "upload_uncertain", created_at: at, cipher: "WORK-CIPHER" }, { id: "object-other", owner_id: CB, path: "TENANT-B-BUSINESS" }],
  creator_storage_deletions: [{ id: "job-own", owner_id: CA, state: "paused", action: "account.self_close", created_at: at, lease_id: "WORK-LEASE", link_hashes: ["WORK-HASH"] }, { id: "job-other", owner_id: CB, state: "TENANT-B-BUSINESS" }],
  wheels: [{ id: "w-own", creator_id: CA, title: "Own wheel" }, { id: "w-other", creator_id: CB, title: "TENANT-B-BUSINESS" }],
  prizes: [...many(2001, (id) => ({ id, wheel_id: "w-own", label: `Own prize ${id}`, cost_cents: 10 })), { id: "p-other", wheel_id: "w-other", label: "TENANT-B-BUSINESS" }],
  fans: [{ id: FAN, creator_id: CA, break_until: "2026-11-01", notes: "Own creator notes" }, { id: OTHER, creator_id: CB, display_name: "TENANT-B-BUSINESS" }],
  fan_passes: [{ id: "link-own", creator_id: CA, fan_id: FAN, token: TOKEN, next_server_seed: "NEXT-SEED-SECRET" }],
  fan_checkins: [{ creator_id: CA, fan_id: FAN, day: "2026-10-01" }, { creator_id: CB, fan_id: OTHER, day: "TENANT-B-BUSINESS" }],
  fan_outreach: [{ id: "out-own", creator_id: CA, fan_id: FAN, contacted_at: at }, { id: "out-other", creator_id: CB, fan_id: OTHER, contacted_at: "TENANT-B-BUSINESS" }],
  push_subscriptions: [{ id: "device-own", user_id: CA, show_details: false, endpoint: "https://fcm.googleapis.com/DEVICE-ENDPOINT", auth: "DEVICE-AUTH", p256dh: "DEVICE-KEY" }, { id: "device-other", user_id: CB }],
  push_log: [{ user_id: CA, item_id: "win:own", tag: "win:own", sent_at: at }, { user_id: CB, item_id: "TENANT-B-BUSINESS" }],
  webhooks: [{ id: "webhook-own", creator_id: CA, event: "win", url: "https://example.test/WEBHOOK-CREDENTIAL" }],
  wheel_templates: [{ id: "template-own", creator_id: CA, prizes: [{ label: "Public template prize", reward: { value: "REWARD-VALUE", cipher: "CIPHER-SECRET" }, private_key: "KEY-SECRET" }] }],
  prize_rewards: [...many(2001, (id) => ({ prize_id: id, creator_id: CA, kind: "text", updated_at: at, ...material })), { prize_id: "other", creator_id: CB, kind: "TENANT-B-BUSINESS" }],
  prize_reward_codes: [...many(2001, (id) => ({ id, prize_id: "p-own", creator_id: CA, spin_id: id, assigned_at: at, created_at: at, erased_at: at, ...material })), { id: "other", creator_id: CB, prize_id: "TENANT-B-BUSINESS" }],
  spin_rewards: [...many(2001, (id) => ({ spin_id: id, creator_id: CA, kind: "code", views: 2, last_viewed_at: at, created_at: at, erased_at: at, ...material })), { spin_id: "other", creator_id: CB, kind: "TENANT-B-BUSINESS" }],
  orgs: [{ id: "org-own", owner_id: CA, name: "Own agency" }, { id: "org-other", owner_id: CB, name: "UNRELATED-AGENCY" }],
  org_members: [{ id: "member-own", org_id: "org-own", profile_id: CA, role: "owner" }, { id: "staff-own", org_id: "org-own", profile_id: "staff", role: "chatter" }, { id: "member-other", org_id: "org-other", profile_id: CB, role: "owner" }],
  org_member_creators: [{ member_id: "member-own", creator_id: CA }, { member_id: "staff-own", creator_id: CA }, { member_id: "member-other", creator_id: CB }],
  org_invites: [{ id: "invite-own", org_id: "org-own", email: "staff@example.test", status: "pending" }, { id: "invite-other", org_id: "org-other", email: "UNRELATED-INVITE" }],
});
let configured = true;
let creatorMode = false;
let serviceDuringCreator = false;
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createServiceClient: () => { if (creatorMode) serviceDuringCreator = true; return { from: (table: string) => svc.from(table) }; },
  createClient: async () => ({ from: (table: string) => session.from(table), auth: { getUser: async () => ({ data: { user: { id: CA, email: "owner@example.test", created_at: at, factors: [] } } }) } }),
} });
let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
async function main() {
  const { exportFanData, exportCreatorData } = await import("./privacy");
  const fan = (await exportFanData(TOKEN))!;
  check("all 2001 top-ups survive the default 1000-row server limit", fan.topUps.length === 2001);
  check("all messages, links, wishes, spins and prize records are paged", fan.messagesYouSent.length === 2001 && fan.links.length === 2001 && fan.wishlist.length === 2001 && fan.spins.length === 2001 && fan.prizes.length === 2001);
  check("all 2001 own instant receipt metadata rows survive paging", fan.instantReceipts?.length === 2001 && fan.instantReceipts[0].views === 3 && fan.instantReceipts[0].erasedAt === at);
  for (const statement of svc.statements.filter((row) => row.table === "spin_rewards")) check("receipts are pinned to the creator and owned spin IDs", eqValue(statement, "creator_id") === CA && !!statement.orders?.some((order) => order.column === "spin_id") && !/cipher|iv|fingerprint|hint|key_version|code_id/.test(statement.columns ?? ""));
  check("an uncapped successful export is marked complete", fan.complete && fan.failed.length === 0 && fan.truncated.length === 0);
  check("the fan gets its own break and private reminder", fan.play.breakUntil === "2026-11-01T00:00:00Z" && fan.play.reminderDaily === 50 && fan.play.reminderUpdatedAt === at);
  check("only the fan's own check-ins and contacts are exported", fan.checkIns.length === 1 && fan.outreach.length === 1 && fan.outreach[0].contactedAt === at);
  check("the fan gets only its own submitted safety report", fan.reportsYouSent.length === 1 && fan.reportsYouSent[0].detail === "My report");
  const fanText = JSON.stringify(fan);
  for (const secret of [TOKEN, "FOREIGN-TOKEN", "NEXT-SEED-SECRET", "PRIVATE-NOTES", "PRIVATE-TAGS", "982341", "SNAPSHOT-PRIVATE", "CIPHER-SECRET", "PRIVATE-DELIVERY-NOTES", "PRIVATE-DUE-DATE", "PRIVATE-SNOOZE", "PRIVATE-TEMPLATE", "UNRELATED-MESSAGE", "CREATOR-REPLY", "UNRELATED-CONTACT", "UNRELATED-REPORT", "FOREIGN-RECEIPT", "FOREIGN-TENANT-RECEIPT", ...Object.values(material)]) check(`fan export excludes ${secret}`, !fanText.includes(secret));
  for (const statement of svc.statements.filter((row) => ["grants", "messages", "wishlists", "spins", "fan_checkins", "fan_outreach", "creator_reports"].includes(row.table))) check(`${statement.table} is doubly scoped and stably ordered`, eqValue(statement, "fan_id") === FAN && eqValue(statement, "creator_id") === CA && !!statement.orders?.length);

  svc.rowLimit = 137;
  const smallPages = (await exportFanData(TOKEN))!;
  check("a smaller configured PostgREST limit is not mistaken for the end", smallPages.messagesYouSent.length === 2001 && smallPages.complete);
  svc.failWhen = (statement) => statement.table === "messages" && statement.range?.[0] === 137 ? "DO-NOT-EXPORT-DB-ERROR" : null;
  const failed = (await exportFanData(TOKEN))!;
  check("a failure after a successful page preserves rows and names the partial source", !failed.complete && failed.failed.includes("messagesYouSent") && failed.messagesYouSent.length === 137);
  check("database diagnostics never enter the download", !JSON.stringify(failed).includes("DO-NOT-EXPORT-DB-ERROR"));
  check("partial download feedback is explicit", /partial/i.test(exportDownloadWarning(failed) ?? ""));
  svc.failWhen = (statement) => statement.table === "spin_rewards" && statement.range?.[0] === 137 ? "RECEIPT-DB-SECRET" : null;
  const receiptFailure = (await exportFanData(TOKEN))!;
  check("receipt query failure is explicitly partial without breaking other exports", !receiptFailure.complete && receiptFailure.failed.includes("instantReceipts") && receiptFailure.instantReceipts.length === 137 && receiptFailure.spins.length === 2001 && !JSON.stringify(receiptFailure).includes("RECEIPT-DB-SECRET"));
  svc.failWhen = null; svc.rowLimit = 1000;
  const originalMessages = svc.tables.messages;
  svc.tables.messages = many(EXPORT_ROW_CAP + 1, (id) => ({ ...owned(id), sender: "fan", body: "Capped message" }));
  const capped = (await exportFanData(TOKEN))!;
  check("a source cap is named and never called complete", capped.messagesYouSent.length === EXPORT_ROW_CAP && !capped.complete && capped.truncated.includes("messagesYouSent"));
  check("a capped file directs the person to get the remaining records", /remaining records/.test(exportDownloadWarning(capped) ?? ""));
  svc.tables.messages = originalMessages;

  creatorMode = true;
  const creator = (await exportCreatorData())!;
  check("creator prizes also survive 1000-row limits", creator.sections.prizes.length === 2001);
  check("all creator reward tables page beyond 1000 rows", creator.sections.prize_rewards.length === 2001 && creator.sections.prize_reward_codes.length === 2001 && creator.sections.spin_rewards.length === 2001);
  check("creator receipt view and erasure metadata are retained", creator.sections.spin_rewards[0].views === 2 && creator.sections.spin_rewards[0].erased_at === at);
  for (const statement of session.statements.filter((row) => ["prize_rewards", "prize_reward_codes", "spin_rewards"].includes(row.table))) check("creator reward queries use only own curated columns", eqValue(statement, "creator_id") === CA && !/cipher|\biv\b|fingerprint|hint|key_version|code_id/.test(statement.columns ?? ""));
  check("creator operational inventory includes visits, outreach and safe device/history rows", creator.sections.fan_checkins.length === 1 && creator.sections.fan_outreach.length === 1 && creator.sections.push_devices.length === 1 && creator.sections.push_history.length === 1);
  check("creator agency export follows only owned memberships/orgs", creator.sections.agency_memberships.length === 1 && creator.sections.agencies_owned.length === 1 && creator.sections.agency_owned_members.length === 2 && creator.sections.agency_invitations.length === 1 && creator.sections.agency_scopes.length === 1 && creator.sections.agency_owned_scopes.length === 2);
  const creatorText = JSON.stringify(creator);
  for (const secret of [TOKEN, "NEXT-SEED-SECRET", "PROFILE-SECRET", "DEVICE-ENDPOINT", "DEVICE-AUTH", "DEVICE-KEY", "WEBHOOK-CREDENTIAL", "REWARD-VALUE", "CIPHER-SECRET", "KEY-SECRET", "TENANT-B-BUSINESS", "UNRELATED-AGENCY", "UNRELATED-INVITE", ...Object.values(material)]) check(`creator export excludes ${secret}`, !creatorText.includes(secret));
  check("media exports survive pagination and filter other creators", creator.sections.creator_media.length === 2001 && creator.sections.creator_media[0].id === "000001");
  check("theme exports include preset keys only", JSON.stringify(creator.account.theme) === JSON.stringify({ font: "syne", background: "noir" }));
  check("durable work metadata is scoped and omits token hashes and leases", creator.sections.storage_objects.length === 1 && creator.sections.storage_deletions.length === 1 && creator.sections.storage_deletions[0].state === "paused");
  for (const secret of ["PHOTO-INTERNAL-PATH", "PHOTO-SIGNED-URL", "PHOTO-BYTES", "THEME-SECRET-URL", "THEME-SECRET-CIPHER", "WORK-CIPHER", "WORK-LEASE", "WORK-HASH", "WORK-DISPATCH-WORKER", "WORK-DISPATCH-ATTEMPT"]) check(`theme/media/work export excludes ${secret}`, !creatorText.includes(secret));
  check("durable dispatch export is tenant scoped", creator.sections.storage_dispatches.length === 1 && creator.sections.storage_dispatches[0].state === "uncertain");
  check("creator export never takes the service-role path", !serviceDuringCreator);
  check("fan-private reminders are deliberately excluded from creator queries", !session.statements.some((statement) => statement.table === "fan_play_reminders") && creator.excluded.some((reason) => reason.includes("fan-private")));
  check("safe complete creator export is marked complete", creator.complete);
  session.failWhen = (statement) => statement.table === "prizes" && statement.range?.[0] === 1000 ? "DB-SECRET" : null;
  const creatorFailed = (await exportCreatorData())!;
  check("creator dependent paged sources report failure truthfully", !creatorFailed.complete && creatorFailed.failed.includes("prizes") && creatorFailed.sections.prizes.length === 1000);
  session.failWhen = (statement) => statement.table === "prize_reward_codes" && statement.range?.[0] === 1000 ? "CODE-DB-SECRET" : null;
  const codesFailure = (await exportCreatorData())!;
  check("creator code metadata query failures stay explicit", !codesFailure.complete && codesFailure.failed.includes("prize_reward_codes") && codesFailure.sections.prize_reward_codes.length === 1000 && !JSON.stringify(codesFailure).includes("CODE-DB-SECRET"));
  session.failWhen = null;

  configured = false; creatorMode = false;
  const demo = await import("./mock");
  const push = await import("./mockPush");
  const link = demo.mockCreatePass("Complete export fan", 2);
  demo.mockAckFan(link.token);
  demo.mockSetPlayReminder(link.token, 50);
  demo.mockRecordCheckin(link.token, "2026-10-28");
  const fanId = demo.mockFanIdForToken(link.token)!;
  demo.mockRecordOutreach(fanId, "contacted", null);
  // Durable delivery fixtures deliberately exceed the display cap and page size.
  // Export must not open values or change their view counts.
  const rewardStore = (globalThis as unknown as { __ffRewards: { prizes: Map<string, unknown>; deliveries: Map<string, unknown> } }).__ffRewards ??= { prizes: new Map(), deliveries: new Map() };
  const receipts = many(2001, (id) => ({ shareId: `instant-${id}`, fanId, prizeId: "instant-prize", label: "Instant", rarity: "common", kind: "code", value: "MOCK-REDEEMABLE-SECRET", fingerprint: "MOCK-FINGERPRINT", views: 4, lastViewedAt: at, at }));
  for (const row of receipts) rewardStore.deliveries.set(String(row.shareId), row);
  rewardStore.deliveries.set("foreign-instant", { ...receipts[0], fanId: "another-fan", label: "MOCK-OTHER-FAN-RECEIPT" });
  rewardStore.prizes.set("instant-prize", { kind: "codes", codes: [{ id: "code-own", fingerprint: "MOCK-FINGERPRINT", value: "MOCK-REDEEMABLE-SECRET", hint: "MOCK-HINT", shareId: "instant-000001", erasedAt: at }] });
  demo.mockTakeBreak(link.token, 86_400_000);
  push.mockAddPushDevice({ endpoint: "https://fcm.googleapis.com/MOCK-PRIVATE-ENDPOINT", p256dh: "MOCK-PRIVATE-KEY", auth: "MOCK-PRIVATE-AUTH" }, "Phone");
  const themeDemo = await import("./mockTheme");
  const photo = themeDemo.mockAddMedia({ webp: Buffer.from("MOCK-PHOTO-SECRET-BYTES"), caption: "Demo photo", width: 10, height: 20 });
  assert.ok(!("error" in photo));
  themeDemo.mockSetTheme({ font: "playfair", background: "photo", bgMediaId: photo.id });
  const mockFan = (await exportFanData(link.token))!;
  const mockCreator = (await exportCreatorData())!;
  check("mock and real fan export have the same top-level contract", Object.keys(mockFan).sort().join() === Object.keys(fan).sort().join());
  check("mock and real creator export have the same section inventory", Object.keys(mockCreator.sections).sort().join() === Object.keys(creator.sections).sort().join());
  check("mock exports carry real play/contact/device data", mockFan.play.reminderDaily === 50 && !!mockFan.play.breakUntil && mockFan.checkIns.length === 1 && mockFan.outreach.length === 1 && mockCreator.sections.push_devices.length === 1);
  check("mock instant exports use full durable history beyond the display cap", mockFan.instantReceipts.length === 2001 && mockFan.spins.filter((row) => row.id.startsWith("instant-")).length === 2001 && mockCreator.sections.spin_rewards.length === 2002);
  check("mock fan receipts remain scoped and export never increments views", mockFan.instantReceipts.every((row) => row.views === 4) && !JSON.stringify(mockFan).includes("MOCK-OTHER-FAN-RECEIPT") && (rewardStore.deliveries.get("instant-000001") as { views: number }).views === 4);
  check("mock code erasure metadata survives without hints or values", mockCreator.sections.prize_reward_codes[0].erased_at === at && !/MOCK-REDEEMABLE-SECRET|MOCK-FINGERPRINT|MOCK-HINT/.test(JSON.stringify([mockFan, mockCreator])));
  check("mock theme/media export uses the real preset keys and safe metadata", (mockCreator.account.theme as Record<string, string>).bg_media_id === photo.id && mockCreator.sections.creator_media[0].caption === "Demo photo" && mockCreator.sections.storage_objects.length === 0 && mockCreator.sections.storage_deletions.length === 0 && !JSON.stringify(mockCreator).includes("MOCK-PHOTO-SECRET-BYTES"));
  check("mock export credentials stay out too", !/MOCK-PRIVATE-ENDPOINT|MOCK-PRIVATE-KEY|MOCK-PRIVATE-AUTH/.test(JSON.stringify(mockCreator)));
  const demoStore = (globalThis as unknown as { __ffStore: { fans: Map<string, { wins: unknown[] }> } }).__ffStore;
  demoStore.fans.get(fanId)!.wins = [{ shareId: "instant-000001", at, label: "Instant", rarity: "common", serverSeed: "spent-only" }, ...many(49, (id) => ({ shareId: `manual-${id}`, at, label: "Manual", rarity: "common", serverSeed: "spent-only" }))];
  const cappedDemo = (await exportFanData(link.token))!;
  check("instant durable refs deduplicate against the recent display", cappedDemo.spins.length === 2050 && cappedDemo.instantReceipts.length === 2001);
  check("pre-existing manual demo history cap remains explicitly partial", !cappedDemo.complete && cappedDemo.truncated.includes("spins") && !demo.mockExportCreatorData().complete && demo.mockExportCreatorData().truncated.includes("spins"));
  console.log(`privacy export completeness: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
