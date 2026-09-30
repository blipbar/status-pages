import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@blipbar/api";
import { look, run } from "../index";
import { parsePages } from "../pages";
import { assess, pageReport, RESOLVED_FOR_MS, statusBlip, type PageReport } from "../report";
import { parseSummary, type PageStatus } from "../statuspage";

// Real summaries, captured 2026-09-30; claude-incident is Claude's 29 September incident as it read while open.
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "../../fixtures", `${name}.json`), "utf8"));
const page = (name: string): PageStatus => parseSummary(fixture(name))!;
const now = new Date("2026-09-30T16:00:00Z");
const watch = (line: string) => parsePages(line)[0];

test("reads one page per line, with the parts after the address", () => {
  const watches = parsePages("https://status.claude.com Claude Code, Claude API\n\n# a note\nhttps://www.githubstatus.com\nstatus.openai.com\nnot an address");
  assert.equal(watches.length, 4);
  assert.deepEqual(watches[0].parts, ["Claude Code", "Claude API"]);
  assert.equal(watches[1].url?.host, "www.githubstatus.com");
  assert.equal(watches[2].problem, "Type it as https://status.openai.com");
  assert.equal(watches[3].problem, "“not” isn’t an address");
});

test("reads Statuspage's summary and incident.io's, which leaves things out", () => {
  const claude = page("claude");
  assert.equal(claude.name, "Claude");
  assert.equal(claude.indicator, "none");
  assert.equal(claude.incidents.length, 0);
  const openai = page("openai-minor");
  assert.equal(openai.indicator, "minor");
  assert.equal(openai.incidents[0].name, "Elevated errors in ChatGPT Space Pages");
  assert.equal(openai.incidents[0].componentIds, undefined);
  assert.equal(parseSummary({ hello: "world" }), undefined);
  assert.equal(parseSummary("<!doctype html>"), undefined);
});

test("a calm page is calm, and the blip says so", () => {
  const report = pageReport(watch("https://status.claude.com"), { kind: "ok", page: page("claude") }, {}, "any", now);
  assert.equal(report.item.state, undefined);
  assert.equal(report.item.subtitle, "Operational");
  const blip = statusBlip([report], { staleAfter: now.toISOString() }) as { state?: string; subtitle?: string };
  assert.equal(blip.state, "idle");
  assert.equal(blip.subtitle, "All operational");
});

test("an outage is red, named, and timed", () => {
  const report = pageReport(watch("https://status.claude.com"), { kind: "ok", page: page("claude-incident") }, {}, "any", now);
  assert.equal(report.item.state, "failure");
  assert.match(report.item.subtitle ?? "", /^Elevated errors on claude\.ai, Claude Code/);
  assert.match(report.item.subtitle ?? "", /· 1d$/);
  assert.deepEqual(report.item.value, { type: "text", value: "Partial outage" });
  assert.equal(report.item.url, "https://stspg.io/br61xzj05pp5");
  assert.deepEqual(report.memory.open?.impact, "major");
});

test("a minor incident is amber, or calm when only outages alert", () => {
  const openai = page("openai-minor");
  const any = pageReport(watch("https://status.openai.com"), { kind: "ok", page: openai }, {}, "any", now);
  assert.equal(any.item.state, "attention");
  assert.match(any.item.subtitle ?? "", /recovering/);
  // incident.io gives no short link; its incidents live at /incidents/<id>.
  assert.equal(any.item.url, "https://status.openai.com/incidents/01M3R1T4FCR1337FBBYY9K2RPB");
  const outages = pageReport(watch("https://status.openai.com"), { kind: "ok", page: openai }, {}, "outages", now);
  assert.equal(outages.item.state, undefined);
  const blip = statusBlip([outages], { staleAfter: now.toISOString() }) as { state?: string; subtitle?: string };
  assert.equal(blip.state, "idle");
  assert.equal(blip.subtitle, "Minor trouble at OpenAI");
});

test("watching parts: an incident elsewhere on the page doesn't count", () => {
  const incident = page("claude-incident");
  assert.equal(assess(incident, ["Claude Code"]).impact, "major");
  // "Claude for Government" isn't in the incident, and stays operational.
  assert.equal(assess(incident, ["Claude for Government"]).impact, "none");
  // A name matches the components it starts.
  assert.equal(assess(incident, ["Claude API"]).incidents.length, 1);
  // incident.io doesn't say what an incident touches: it counts only while a watched part shows trouble.
  assert.equal(assess(page("openai-minor"), ["Conversations"]).impact, "none");
});

test("a part the page doesn't have is a setting to fix", () => {
  const report = pageReport(watch("https://status.claude.com Claude Codex"), { kind: "ok", page: page("claude") }, {}, "any", now);
  assert.equal(report.item.state, "failure");
  assert.match(report.item.subtitle ?? "", /^No “Claude Codex” here · it lists claude\.ai/);
});

test("a whole page goes by its own indicator, not every component", () => {
  // Cloudflare always has data centres re-routed or in maintenance; its page says minor.
  const cloudflare = parseSummary({
    page: { name: "Cloudflare Status", url: "https://www.cloudflarestatus.com" },
    status: { indicator: "minor", description: "Minor Service Outage" },
    components: [{ id: "ari", name: "Arica, Chile - (ARI)", status: "partial_outage" }],
    incidents: [{ id: "1", name: "Network Performance Issues in Madrid", status: "monitoring", impact: "minor", components: [] }],
  })!;
  assert.equal(cloudflare.name, "Cloudflare");
  assert.equal(assess(cloudflare, []).impact, "minor");
  assert.equal(assess(cloudflare, ["Arica"]).impact, "major");
});

test("a group brings its members", () => {
  const grouped = parseSummary({
    page: { name: "Acme", url: "https://status.acme.dev" },
    status: { indicator: "minor" },
    components: [
      { id: "g", name: "Europe", group: true, status: "degraded_performance" },
      { id: "a", name: "Frankfurt", group_id: "g", status: "degraded_performance" },
      { id: "b", name: "Virginia", status: "operational" },
    ],
    incidents: [],
  })!;
  const europe = assess(grouped, ["Europe"]);
  assert.equal(europe.impact, "minor");
  assert.deepEqual(europe.degraded.map((c) => c.name), ["Frankfurt"]);
  assert.equal(assess(grouped, ["Virginia"]).impact, "none");
});

test("trouble that alerted says it's resolved, green, for a while", () => {
  const w = watch("https://status.claude.com");
  const during = pageReport(w, { kind: "ok", page: page("claude-incident") }, {}, "any", now);
  const after = pageReport(w, { kind: "ok", page: page("claude") }, during.memory, "any", now);
  assert.equal(after.item.state, "success");
  assert.deepEqual(after.item.value, { type: "text", value: "Resolved" });
  const later = new Date(now.getTime() + RESOLVED_FOR_MS + 1000);
  const settled = pageReport(w, { kind: "ok", page: page("claude") }, after.memory, "any", later);
  assert.equal(settled.item.state, undefined);
  assert.deepEqual(settled.memory, {});
});

test("minor trouble that never alerted clears quietly", () => {
  const w = watch("https://status.openai.com");
  const during = pageReport(w, { kind: "ok", page: page("openai-minor") }, {}, "outages", now);
  const after = pageReport(w, { kind: "ok", page: page("claude") }, during.memory, "outages", now);
  assert.equal(after.item.state, undefined);
});

test("a page that can't be reached keeps what it said and decides nothing new", () => {
  const w = watch("https://status.claude.com");
  const during = pageReport(w, { kind: "ok", page: page("claude-incident") }, {}, "any", now);
  const offline = pageReport(w, { kind: "unreachable", page: page("claude-incident") }, during.memory, "any", now);
  assert.equal(offline.item.state, "failure");
  assert.deepEqual(offline.memory, during.memory);
  const never = pageReport(w, { kind: "unreachable" }, {}, "any", now);
  assert.equal(never.item.state, "offline");
});

test("the loudest page leads, and the ear names it", () => {
  const reports: PageReport[] = [
    pageReport(watch("https://www.githubstatus.com"), { kind: "ok", page: page("github") }, {}, "any", now),
    pageReport(watch("https://status.openai.com"), { kind: "ok", page: page("openai-minor") }, {}, "any", now),
    pageReport(watch("https://status.claude.com"), { kind: "ok", page: page("claude-incident") }, {}, "any", now),
  ];
  const blip = statusBlip(reports, { staleAfter: now.toISOString() }) as {
    state?: string;
    subtitle?: string;
    data: { items: { title: string }[]; value?: unknown };
  };
  assert.equal(blip.state, "failure");
  assert.deepEqual(blip.data.items.map((i) => i.title), ["Claude", "OpenAI", "GitHub"]);
  assert.match(blip.subtitle ?? "", /^Claude: Elevated errors/);
  assert.deepEqual(blip.data.value, { type: "text", value: "Claude" });
});

test("a wrong address alone still names itself in the row", () => {
  const report = pageReport(watch("https://status.stripe.com"), { kind: "not-status" }, {}, "any", now);
  const blip = statusBlip([report], { staleAfter: now.toISOString() }) as { subtitle?: string; data: { value?: unknown } };
  assert.equal(blip.subtitle, "status.stripe.com: No status API here · check the address");
  assert.deepEqual(blip.data.value, { type: "text", value: "status.stripe.com" });
});

// ── Looking, with a stand-in for the network ──

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 || body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

/** A fake page: answers each API path from `routes`, and records what was asked. */
function server(routes: Record<string, () => Response>) {
  const asked: { path: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    asked.push({ path, headers: (init?.headers ?? {}) as Record<string, string> });
    return (routes[path] ?? (() => respond(404, "Not found")))();
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

const claude = fixture("claude") as { page: object; status: object; incidents: unknown[] };
const statusOf = (summary: { page: object; status: object }) => ({ page: summary.page, status: summary.status });

test("a page that hasn't changed costs one 304", async () => {
  let etag = 'W/"1"';
  let updated = "2026-09-30T21:09:56.563Z";
  const { fetchImpl, asked } = server({
    "/api/v2/status.json": () =>
      asked.at(-1)?.headers["If-None-Match"] === etag
        ? respond(304)
        : respond(200, { page: { ...claude.page, updated_at: updated }, status: claude.status }, { etag }),
    "/api/v2/incidents/unresolved.json": () => respond(200, { page: claude.page, incidents: [] }),
  });
  const url = new URL("https://status.claude.com");
  const first = await look(url, false, undefined, fetchImpl);
  assert.deepEqual(asked.map((a) => a.path), ["/api/v2/status.json", "/api/v2/incidents/unresolved.json"]);
  const second = await look(url, false, first.cache, fetchImpl);
  assert.equal(second.look.kind, "ok");
  assert.equal(asked.length, 3);
  assert.equal(asked[2].headers["Cache-Control"], "max-age=0");
  etag = 'W/"2"';
  const third = await look(url, false, second.cache, fetchImpl);
  assert.equal(asked.length, 4, "a new ETag, but the page says it hasn't changed");
  etag = 'W/"3"';
  updated = "2026-09-30T22:00:00.000Z";
  await look(url, false, third.cache, fetchImpl);
  assert.equal(asked.length, 6, "the page changed: what's open is fetched again");
});

test("incident.io: no ETag and no unresolved list, so the summary, and only when it changed", async () => {
  const openai = fixture("openai-minor") as { page: object; status: object };
  const { fetchImpl, asked } = server({
    "/api/v2/status.json": () => respond(200, statusOf(openai)),
    "/api/v2/summary.json": () => respond(200, openai),
  });
  const url = new URL("https://status.openai.com");
  const first = await look(url, false, undefined, fetchImpl);
  assert.deepEqual(asked.map((a) => a.path), ["/api/v2/status.json", "/api/v2/incidents/unresolved.json", "/api/v2/summary.json"]);
  assert.equal(first.look.kind === "ok" && first.look.page.incidents[0].name, "Elevated errors in ChatGPT Space Pages");
  await look(url, false, first.cache, fetchImpl);
  assert.equal(asked.length, 4, "the same last-updated time: nothing more fetched");
});

test("watching parts fetches the components, once", async () => {
  const { fetchImpl, asked } = server({
    "/api/v2/status.json": () => respond(200, statusOf(claude), { etag: '"1"' }),
    "/api/v2/summary.json": () => respond(200, claude),
  });
  const url = new URL("https://status.claude.com");
  const whole = await look(url, false, undefined, fetchImpl);
  const parts = await look(url, true, whole.cache, fetchImpl);
  assert.equal(parts.look.kind === "ok" && parts.look.page.components.length, 6);
  assert.equal(asked.filter((a) => a.path === "/api/v2/summary.json").length, 2, "unresolved.json 404s here, then the parts need it");
});

test("a page that moved, a page with no API, and no network", async () => {
  const refused = (async () => {
    throw new Error('network access to "status.claude.com" is not permitted — add it to "blipbar.permissions.network"');
  }) as unknown as typeof fetch;
  assert.deepEqual((await look(new URL("https://status.anthropic.com"), false, undefined, refused)).look, { kind: "moved", host: "status.claude.com" });
  const html = (async () => respond(200, "<!doctype html><title>Status</title>")) as unknown as typeof fetch;
  assert.equal((await look(new URL("https://status.stripe.com"), false, undefined, html)).look.kind, "not-status");
  const missing = server({}).fetchImpl;
  assert.equal((await look(new URL("https://example.com"), false, undefined, missing)).look.kind, "not-status");
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.equal((await look(new URL("https://status.claude.com"), false, undefined, offline)).look.kind, "unreachable");
});

function mockContext(preferences: Record<string, string>) {
  const stored = new Map<string, unknown>();
  const emitted: unknown[] = [];
  let writes = 0;
  const ctx = {
    preferences,
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        writes++;
        stored.set(key, JSON.parse(JSON.stringify(value)));
      },
      delete: async (key: string) => void stored.delete(key),
    },
    emit: (blip: unknown) => void emitted.push(blip),
  } as unknown as Context;
  return { ctx, emitted, writes: () => writes };
}

test("a run looks at each page once, and a quiet run doesn't write", async () => {
  const { ctx, emitted, writes } = mockContext({ pages: "https://status.claude.com Claude Code\nhttps://status.claude.com claude.ai" });
  const { fetchImpl, asked } = server({
    "/api/v2/status.json": () => (asked.at(-1)?.headers["If-None-Match"] ? respond(304) : respond(200, statusOf(claude), { etag: '"1"' })),
    "/api/v2/summary.json": () => respond(200, claude),
  });
  const first = await run(ctx, fetchImpl, now);
  assert.deepEqual(asked.map((a) => a.path), ["/api/v2/status.json", "/api/v2/summary.json"]);
  assert.equal(first.nextRunAfter, 120);
  assert.equal((emitted[0] as { data: { items: unknown[] } }).data.items.length, 2);
  await run(ctx, fetchImpl, now);
  assert.equal(asked.length, 3);
  assert.equal(writes(), 1);
});

test("no network on the first run says offline, then backs off", async () => {
  const { ctx, emitted } = mockContext({ pages: "https://status.claude.com" });
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await run(ctx, offline, now);
  assert.equal((emitted[0] as { state?: string }).state, "offline");
  assert.equal(result.nextRunAfter, 60);
  const again = await run(ctx, offline, now);
  assert.equal(again.nextRunAfter, 120);
});
