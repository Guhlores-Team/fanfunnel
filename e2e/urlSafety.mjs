import { BASE } from "./harness.mjs";

/** Malformed routing must fail before dynamic params or auth are evaluated. */
export async function urlSafetyJourney(_page, { step, assert }, ctx) {
  await step("routing: malformed encoding gives generic 400 with security headers", async () => {
    const secrets = ["routing-private-fan", "routing-private-query", "routing-private-agent"];
    for (const path of ["/%", "/%C0%AF", "/spin/routing-private-fan%", "/spin/%E0%A4%A", "/c/%FF", "/dashboard/%", "/api/fans/%"]) {
      const response = await ctx.request.get(`${BASE}${path}?token=routing-private-query`, { headers: { "user-agent": "routing-private-agent" } });
      assert(response.status() === 400, `${path} is a bad request rather than a server error`);
      assert(JSON.stringify(await response.json()) === '{"error":"bad_request"}', "no supplied URL data is reflected");
      const headers = response.headers();
      assert(headers["cache-control"] === "no-store", "malformed responses are never cached");
      assert(headers["referrer-policy"] === "strict-origin-when-cross-origin" && headers["x-content-type-options"] === "nosniff" && headers["x-frame-options"] === "SAMEORIGIN", "routing rejection keeps security response headers");
    }
    let errors = [];
    const deadline = Date.now() + 5000;
    do {
      const response = await ctx.request.get(BASE + "/api/admin/errors?status=open");
      assert(response.ok(), "demo admin can verify recorded routing errors");
      errors = (await response.json()).errors.filter((row) => row.message === "Malformed URL encoding rejected");
      if (errors.length && errors.some((row) => row.count >= 7)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert(errors.length > 0 && errors.some((row) => row.count >= 7), "background monitoring records the rejected requests");
    assert(errors.every((row) => row.source === "server" && row.route === "/[invalid-encoding]" && row.userAgent === null), "monitoring contains only static request context");
    assert(secrets.every((secret) => !JSON.stringify(errors).includes(secret)), "fan path, query and headers stay out of monitoring");
    assert((await ctx.request.get(BASE + "/spin/%25")).status() === 404, "a literal escaped percent is valid encoding and reaches ordinary link lookup");
    for (const path of ["/terms", "/privacy"]) assert((await ctx.request.get(BASE + path)).status() === 200, "healthy public routes keep working");
  });
}
