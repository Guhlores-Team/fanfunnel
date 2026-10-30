import assert from "node:assert";
import { mock } from "node:test";

// /c/<slug> stays ISR at 60s, but every route that changes what it renders
// marks the creator's page stale right after a SUCCESSFUL write: wheel save,
// activate/schedule/unarchive, archive/delete, brand colour, display name and
// the public-profile fields. A rejected write must not revalidate anything.
// Runs against the in-memory mock data layer, whose creator slug is
// "demo-creator"; next/cache is the only module swapped out.

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const calls: unknown[][] = [];
mock.module("next/cache", {
  namedExports: {
    revalidatePath: (...args: unknown[]) => {
      calls.push(args);
    },
  },
});

const PAGE = "/c/demo-creator";

function req(method: string, url: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Run `fn`, then assert the revalidation it caused (or didn't). */
async function expectRevalidated(label: string, want: boolean, fn: () => Promise<Response>) {
  calls.length = 0;
  const res = await fn();
  check(`${label}: ${want ? "succeeds" : "is rejected"} (${res.status})`, res.ok === want);
  if (want) {
    check(`${label}: revalidates ${PAGE} once`, calls.length === 1 && calls[0][0] === PAGE);
    check(`${label}: as a literal path (no type)`, calls[0]?.length === 1);
  } else {
    check(`${label}: no revalidation`, calls.length === 0);
  }
}

async function main() {
  const wheelRoute = await import("@/app/api/wheel/route");
  const wheelIdRoute = await import("@/app/api/wheels/[id]/route");
  const profileRoute = await import("@/app/api/account/profile/route");
  const brandRoute = await import("@/app/api/account/brand-color/route");
  const publicProfileRoute = await import("@/app/api/public-profile/route");
  const { getWheel, createWheel } = await import("@/lib/data");

  const live = await getWheel();
  assert.ok(live, "mock wheel");

  // Wheel save.
  await expectRevalidated("wheel save", true, () => wheelRoute.PUT(req("PUT", "/api/wheel", { wheel: live })));
  await expectRevalidated("invalid wheel save", false, () =>
    wheelRoute.PUT(req("PUT", "/api/wheel", { wheel: { ...live, prizes: [live!.prizes[0]] } }))
  );

  // Activate / schedule / unarchive (PATCH), archive and delete (DELETE).
  const { wheel: extra } = await createWheel({ name: "Extra" });
  await expectRevalidated("activate", true, () =>
    wheelIdRoute.PATCH(req("PATCH", `/api/wheels/${extra.id}`, { isActive: true }), params(extra.id))
  );
  await expectRevalidated("schedule", true, () =>
    wheelIdRoute.PATCH(
      req("PATCH", `/api/wheels/${extra.id}`, { activeFrom: null, activeUntil: null }),
      params(extra.id)
    )
  );
  await expectRevalidated("activate unknown wheel", false, () =>
    wheelIdRoute.PATCH(req("PATCH", "/api/wheels/nope", { isActive: true }), params("nope"))
  );
  await expectRevalidated("archive", true, () =>
    wheelIdRoute.DELETE(req("DELETE", `/api/wheels/${extra.id}`), params(extra.id))
  );
  await expectRevalidated("unarchive", true, () =>
    wheelIdRoute.PATCH(req("PATCH", `/api/wheels/${extra.id}`, { archived: false }), params(extra.id))
  );
  await expectRevalidated("delete", true, () =>
    wheelIdRoute.DELETE(req("DELETE", `/api/wheels/${extra.id}?hard=1`), params(extra.id))
  );
  await expectRevalidated("re-activate the original wheel", true, () =>
    wheelIdRoute.PATCH(req("PATCH", `/api/wheels/${live!.id}`, { isActive: true }), params(live!.id))
  );

  // Brand colour of the live wheel.
  await expectRevalidated("brand colour", true, () =>
    brandRoute.PUT(req("PUT", "/api/account/brand-color", { color: live!.brandColor ?? "#ec4899" }))
  );
  await expectRevalidated("invalid brand colour", false, () =>
    brandRoute.PUT(req("PUT", "/api/account/brand-color", { color: "pink" }))
  );

  // Display name.
  await expectRevalidated("display name", true, () =>
    profileRoute.PUT(req("PUT", "/api/account/profile", { displayName: "Demo Creator" }))
  );
  await expectRevalidated("blank display name", false, () =>
    profileRoute.PUT(req("PUT", "/api/account/profile", { displayName: "  " }))
  );

  // Public-profile fields (already revalidated old + new slug; same slug here).
  await expectRevalidated("public-profile tagline", true, () =>
    publicProfileRoute.PUT(req("PUT", "/api/public-profile", { tagline: "Spin me" }))
  );
  await expectRevalidated("invalid public-profile slug", false, () =>
    publicProfileRoute.PUT(req("PUT", "/api/public-profile", { slug: "bad/slug" }))
  );

  console.log(`publicPage revalidation: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
