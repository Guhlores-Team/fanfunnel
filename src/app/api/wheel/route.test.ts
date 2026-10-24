import assert from "node:assert";

// Route-level test for PUT /api/wheel, run against the in-memory mock data
// layer. Clear the Supabase env before importing so the route can't reach a
// real project.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

(async () => {
  const { PUT } = await import("./route");
  const { getWheel } = await import("@/lib/data");

  const base = await getWheel();
  assert.ok(base, "mock wheel available");

  async function put(body: unknown) {
    const res = await PUT(
      new Request("http://localhost/api/wheel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  // Invalid brand color: rejected, nothing persisted.
  {
    const r = await put({ wheel: { ...base, brandColor: "garbage" } });
    check("garbage brand color → 400", r.status === 400);
    check("garbage brand color → bad_color", r.data.error === "bad_color");
    const after = await getWheel();
    check("garbage brand color not persisted", after?.brandColor === base!.brandColor);
  }

  {
    const r = await put({ wheel: { ...base, labelColor: "white" } });
    check("garbage label color → 400 bad_color", r.status === 400 && r.data.error === "bad_color");
  }

  {
    const prizes = base!.prizes.map((p, i) => (i === 0 ? { ...p, color: "javascript:x" } : p));
    const r = await put({ wheel: { ...base, prizes } });
    check("garbage prize color → 400 bad_color", r.status === 400 && r.data.error === "bad_color");
  }

  {
    const prizes = base!.prizes.map((p, i) => (i === 0 ? { ...p, stock: -3 } : p));
    const r = await put({ wheel: { ...base, prizes } });
    check("negative stock → 400 bad_stock", r.status === 400 && r.data.error === "bad_stock");
  }

  // A cleared prize color ("") is unset, not invalid: the editor allows it.
  {
    const prizes = base!.prizes.map((p, i) => (i === 0 ? { ...p, color: "" } : p));
    const r = await put({ wheel: { ...base, prizes } });
    check("empty prize color → 200", r.status === 200);
    const saved = r.data.wheel as { prizes: { color?: string | null }[] };
    check("empty prize color saved as unset", saved.prizes[0].color == null);
  }

  // Valid shorthand is accepted and normalized; the response shape is unchanged.
  {
    const r = await put({ wheel: { ...base, brandColor: "#ABC", labelColor: "#FFF" } });
    check("valid #rgb → 200", r.status === 200);
    const saved = r.data.wheel as { brandColor?: string; labelColor?: string; prizes?: unknown[] };
    check("response still carries { wheel }", !!saved && Array.isArray(saved.prizes));
    check("brand color normalized to #rrggbb", saved.brandColor === "#aabbcc");
    check("label color normalized to #rrggbb", saved.labelColor === "#ffffff");
  }

  // Existing behavior kept: a plain save without colors still works.
  {
    const r = await put({ wheel: { ...base, brandColor: undefined, labelColor: undefined } });
    check("save without colors → 200", r.status === 200);
  }

  console.log(`api/wheel route: ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
