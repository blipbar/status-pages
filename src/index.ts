import { backoff, connectionBlip, defineExtension, staleAfter, type Context, type UpdateResult } from "@blipbar/api";
import { parsePages, watchID } from "./pages";
import { pageReport, statusBlip, type AlertFor, type Look, type WatchMemory } from "./report";
import { apiURL, parseComponents, parseIncidents, parseStatus, type PageStatus } from "./statuspage";

/** A quiet page is looked at every two minutes; one in trouble, every minute. */
const CALM_SECONDS = 120;
const TROUBLE_SECONDS = 60;

interface Cached {
  /** `status.json`'s ETag, for a 304 where the page sends one. */
  etag?: string;
  /** `status.json`'s last change and indicator: unchanged means nothing else is worth fetching. */
  version: string;
  /** Whether `page` has the components, which only a page watched in parts needs. */
  withParts: boolean;
  page: PageStatus;
}

interface Memory {
  /** Per page (its origin): what it said, so a page that hasn't changed costs one small look. */
  pages: Record<string, Cached>;
  /** Per watched line, for saying when trouble clears. */
  watches: Record<string, WatchMemory>;
  /** Runs in a row that reached no page at all. */
  failures: number;
  /** Something has been shown since launch. */
  shown?: boolean;
}

export default defineExtension({
  async update(ctx) {
    return run(ctx, fetch, new Date());
  },
});

/** One run: look at every page (each address once), then emit the one blip. */
export async function run(ctx: Context, fetchImpl: typeof fetch, now: Date): Promise<UpdateResult> {
  const watches = parsePages(typeof ctx.preferences.pages === "string" ? ctx.preferences.pages : "");
  const alertFor: AlertFor = ctx.preferences.alertFor === "outages" ? "outages" : "any";
  const saved = (await ctx.storage.get<Memory>("memory")) ?? { pages: {}, watches: {}, failures: 0 };
  const memory: Memory = { pages: {}, watches: {}, failures: saved.failures, shown: saved.shown };

  // Each page once, however many lines watch it; with its components if any line wants parts.
  const origins = new Map<string, URL>();
  const withParts = new Set<string>();
  for (const watch of watches) {
    if (!watch.url) continue;
    origins.set(watch.url.origin, watch.url);
    if (watch.parts.length > 0) withParts.add(watch.url.origin);
  }
  const looks = new Map(
    await Promise.all(
      [...origins].map(async ([origin, url]) => [origin, await look(url, withParts.has(origin), saved.pages[origin], fetchImpl)] as const),
    ),
  );

  // The network's gone: leave what's shown to dim by itself, and look again later.
  if (looks.size > 0 && [...looks.values()].every(({ look }) => look.kind === "unreachable")) {
    const failures = saved.failures + 1;
    const next = backoff(failures);
    if (!saved.shown) {
      ctx.emit(connectionBlip({ key: "status", service: "the status pages", icon: "waveform.path.ecg", trouble: "offline", staleAfter: staleAfter(next, now) }));
    }
    await save(ctx, saved, { ...saved, failures });
    return { nextRunAfter: next };
  }

  for (const [origin, { cache }] of looks) if (cache) memory.pages[origin] = cache;
  const reports = watches.map((watch) => {
    const id = watchID(watch);
    const result: Look = watch.problem || !watch.url ? { kind: "invalid", problem: watch.problem ?? "Not an address" } : looks.get(watch.url.origin)!.look;
    const report = pageReport(watch, result, saved.watches[id] ?? {}, alertFor, now);
    if (Object.keys(report.memory).length > 0) memory.watches[id] = report.memory;
    return report;
  });

  const inTrouble = reports.some(({ item }) => item.state === "failure" || item.state === "attention" || item.state === "running");
  const next = inTrouble ? TROUBLE_SECONDS : CALM_SECONDS;
  ctx.emit(statusBlip(reports, { staleAfter: staleAfter(next, now) }));
  await save(ctx, saved, { ...memory, failures: 0, shown: true });
  return { nextRunAfter: next };
}

/**
 * One small look at `status.json`, and more only when the page changed since last time.
 * It sends back the ETag it was given, with `Cache-Control: max-age=0`: on a conditional
 * request Node's `fetch` otherwise adds `no-cache`, which a server may answer with the
 * whole body instead of a 304. Pages that send no ETag (incident.io's) answer in full,
 * and the page's own "last updated" says whether anything changed.
 */
export async function look(page: URL, needsParts: boolean, cached: Cached | undefined, fetchImpl: typeof fetch): Promise<{ look: Look; cache?: Cached }> {
  const usable = cached && (cached.withParts || !needsParts) ? cached : undefined;
  const get = (url: string, etag?: string) =>
    fetchImpl(url, {
      headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag, "Cache-Control": "max-age=0" } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  const unreachable = { look: { kind: "unreachable", page: cached?.page } as Look, cache: cached };

  let response: Response;
  try {
    response = await get(apiURL(page, "status"), usable?.etag);
  } catch (error) {
    // Blipbar refuses a redirect to a host the typed address doesn't grant: the page moved
    // (status.anthropic.com to status.claude.com), and the address needs changing.
    const refused = /network access to "([^"]+)" is not permitted/.exec(error instanceof Error ? error.message : String(error));
    if (refused && refused[1] !== page.hostname) return { look: { kind: "moved", host: refused[1] } };
    return unreachable;
  }
  if (response.status === 304 && usable) return { look: { kind: "ok", page: usable.page }, cache: usable };
  if (response.status === 404 || response.status === 410) return { look: { kind: "not-status" } };
  if (!response.ok) return unreachable;
  const summary = parseStatus(await response.json().catch(() => undefined));
  if (!summary) return { look: { kind: "not-status" } };

  const etag = response.headers.get("etag") ?? undefined;
  const version = `${summary.updatedAt ?? ""}|${summary.indicator}`;
  if (usable && usable.version === version) {
    const page = { ...usable.page, ...summary };
    return { look: { kind: "ok", page }, cache: { ...usable, etag, page } };
  }

  // Something changed: what's open now, and the components if a line watches parts.
  try {
    let details: unknown;
    if (!needsParts) {
      const open = await get(apiURL(page, "incidents/unresolved"));
      if (open.ok) details = await open.json();
      else await open.arrayBuffer().catch(() => undefined);
    }
    if (details === undefined) {
      const full = await get(apiURL(page, "summary"));
      if (!full.ok) return unreachable;
      details = await full.json();
    }
    const incidents = parseIncidents(details);
    if (!incidents) return unreachable;
    const status: PageStatus = { ...summary, incidents, components: needsParts ? parseComponents(details) : [] };
    return { look: { kind: "ok", page: status }, cache: { etag, version, withParts: needsParts, page: status } };
  } catch {
    return unreachable;
  }
}

/** Writes only what changed, so a quiet run doesn't touch the disk. */
async function save(ctx: Context, before: Memory, after: Memory): Promise<void> {
  if (JSON.stringify(before) !== JSON.stringify(after)) await ctx.storage.set("memory", after);
}

export { parsePages } from "./pages";
export { assess, pageReport, statusBlip } from "./report";
export { parseStatus, parseSummary } from "./statuspage";
