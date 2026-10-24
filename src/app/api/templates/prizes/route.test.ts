import assert from "node:assert";

// Route-level test for POST /api/templates/prizes against the in-memory mock
// data layer (Supabase env cleared so nothing reaches a real project).
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

(async () => {
  const { POST, GET } = await import("./route");

  async function post(body: unknown) {
    const res = await POST(
      new Request("http://localhost/api/templates/prizes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  async function labels(): Promise<string[]> {
    const data = (await (await GET()).json()) as { templates: { label: string }[] };
    return data.templates.map((t) => t.label);
  }

  {
    const r = await post({ label: "Bad color", rarity: "rare", weight: 5, color: "garbage" });
    check("garbage color → 400", r.status === 400);
    check("garbage color → bad_color", r.data.error === "bad_color");
    check("garbage color not stored", !(await labels()).includes("Bad color"));
  }
  {
    const r = await post({ label: "Injected", rarity: "rare", weight: 5, color: "#fff;background:url(x)" });
    check("css-ish color → 400 bad_color", r.status === 400 && r.data.error === "bad_color");
  }
  {
    const r = await post({ label: "Short hex", rarity: "rare", weight: 5, color: "#ABC" });
    const t = r.data.template as { color?: string } | undefined;
    check("#rgb accepted → 200", r.status === 200);
    check("color normalized to lowercase #rrggbb", t?.color === "#aabbcc");
  }
  {
    const r = await post({ label: "No color", rarity: "common", weight: 5 });
    check("no color still accepted → 200", r.status === 200 && !!r.data.template);
  }

  console.log(`api/templates/prizes route: ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
