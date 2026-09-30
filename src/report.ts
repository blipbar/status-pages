/**
 * What each page's row says, and the one blip that holds them. Plain functions, data in and
 * data out, so the tests can check every case without a network.
 */
import { age, clip, joinLine, list, names, number, text, type BlipInput, type BlipState, type ListItem } from "@blipbar/api";
import { watchID, type Watch } from "./pages";
import { componentImpact, incidentURL, RANK, type Component, type Impact, type Incident, type PageStatus } from "./statuspage";

/** "any": minor trouble lights the notch too. "outages": only partial and major outages do. */
export type AlertFor = "any" | "outages";

/** How a look at one page went. */
export type Look =
  | { kind: "ok"; page: PageStatus }
  /** The network, or the page's own trouble; what it said last time, if anything. */
  | { kind: "unreachable"; page?: PageStatus }
  /** Answered, but not with a status summary: a page this can't read, or a wrong address. */
  | { kind: "not-status" }
  /** It redirects to another host, which the typed address doesn't grant. */
  | { kind: "moved"; host: string }
  /** The line itself is wrong. */
  | { kind: "invalid"; problem: string };

/** Kept between runs, per watched line, to say when trouble clears. */
export interface WatchMemory {
  open?: { name: string; impact: Impact; url?: string };
  resolved?: { name: string; at: string; url?: string };
}

/** How long a cleared incident stays green in the list. */
export const RESOLVED_FOR_MS = 10 * 60_000;

const WORDS: Record<Impact, string | undefined> = {
  none: undefined,
  maintenance: "Maintenance",
  minor: "Degraded",
  major: "Partial outage",
  critical: "Major outage",
};

export interface Assessment {
  impact: Impact;
  /** In scope, worst first. */
  incidents: Incident[];
  /** Watched components that aren't operational. */
  degraded: Component[];
  /** Names typed that match nothing on the page. */
  unknownParts: string[];
}

/**
 * Which components a line means. Exact names win; otherwise a name matches the components
 * it starts ("Claude API" finds "Claude API (api.anthropic.com)"). A group brings its members.
 */
export function scope(components: readonly Component[], parts: readonly string[]): { ids: Set<string>; unknown: string[] } | undefined {
  if (parts.length === 0) return undefined;
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const part of parts) {
    const wanted = part.toLowerCase();
    const exact = components.filter((c) => c.name.toLowerCase() === wanted);
    const found = exact.length > 0 ? exact : components.filter((c) => c.name.toLowerCase().startsWith(wanted));
    if (found.length === 0) unknown.push(part);
    for (const component of found) {
      ids.add(component.id);
      if (component.isGroup) for (const member of components) if (member.groupId === component.id) ids.add(member.id);
    }
  }
  return { ids, unknown };
}

export function assess(page: PageStatus, parts: readonly string[]): Assessment {
  const watched = scope(page.components, parts);
  const incidents = [...page.incidents].sort((a, b) => RANK[b.impact] - RANK[a.impact]);
  if (!watched) {
    // The whole page: its own indicator says how it's doing. Its components aren't read,
    // since a big page always has a few (data centres re-routed, one region slow) that
    // don't make an incident.
    const impact = incidents.reduce<Impact>((worst, i) => (RANK[i.impact] > RANK[worst] ? i.impact : worst), page.indicator);
    return { impact, incidents, degraded: [], unknownParts: [] };
  }
  // A group's status only repeats its members'.
  const degraded = page.components.filter((c) => !c.isGroup && watched.ids.has(c.id) && componentImpact(c.status) !== "none");
  const touching = incidents.filter((incident) =>
    incident.componentIds && incident.componentIds.length > 0
      ? incident.componentIds.some((id) => watched.ids.has(id))
      : // The page doesn't say what it touches: count it only while something watched is in trouble.
        degraded.length > 0,
  );
  const levels: Impact[] = [...touching.map((i) => i.impact), ...degraded.map((c) => componentImpact(c.status))];
  const impact = levels.reduce<Impact>((worst, level) => (RANK[level] > RANK[worst] ? level : worst), "none");
  return { impact, incidents: touching, degraded, unknownParts: watched.unknown };
}

/** Red for an outage, amber for degraded (unless only outages alert). Maintenance is planned, so it stays calm. */
export function stateFor(impact: Impact, alertFor: AlertFor): BlipState | undefined {
  switch (impact) {
    case "critical":
    case "major":
      return "failure";
    case "minor":
      return alertFor === "any" ? "attention" : undefined;
    case "maintenance":
    case "none":
      return undefined;
  }
}

export interface PageReport {
  item: ListItem;
  /** The line for the row when this is the one page in trouble. */
  headline?: string;
  memory: WatchMemory;
}

export function pageReport(watch: Watch, look: Look, previous: WatchMemory, alertFor: AlertFor, now: Date): PageReport {
  const id = watchID(watch);
  const host = watch.url?.host ?? watch.address;
  switch (look.kind) {
    case "invalid":
      return { item: { id, title: watch.address, subtitle: look.problem, state: "failure" }, memory: previous };
    case "not-status":
      return { item: { id, title: host, subtitle: "No status API here · check the address", state: "failure", url: watch.url?.href }, memory: previous };
    case "moved":
      return { item: { id, title: host, subtitle: `Moved to ${look.host} · change the address`, state: "failure" }, memory: previous };
    case "unreachable":
      // Nothing known yet: say so. Known before: show that, and decide nothing new from it.
      if (!look.page) return { item: { id, title: host, subtitle: "Can’t reach it", state: "offline", url: watch.url?.href }, memory: previous };
      return { ...describe(id, watch, look.page, assess(look.page, watch.parts), previous, alertFor, now), memory: previous };
    case "ok": {
      const assessment = assess(look.page, watch.parts);
      const memory = remember(previous, assessment, look.page, alertFor, now);
      return { ...describe(id, watch, look.page, assessment, memory, alertFor, now), memory };
    }
  }
}

function describe(id: string, watch: Watch, page: PageStatus, assessment: Assessment, memory: WatchMemory, alertFor: AlertFor, now: Date): Omit<PageReport, "memory"> {
  const title = page.name;
  const pageURL = page.url || watch.url?.href;

  if (assessment.unknownParts.length > 0) {
    const listed = page.components.filter((c) => !c.isGroup).map((c) => c.name);
    const subtitle = clip(`No “${assessment.unknownParts[0]}” here · it lists ${listed.join(", ")}`, 90);
    return { item: { id, title, subtitle, state: "failure", url: pageURL } };
  }

  const { impact, incidents, degraded } = assessment;
  if (impact !== "none" || incidents.length > 0) {
    const lead = incidents[0];
    const what = lead
      ? lead.name
      : degraded.length > 0
        ? `${names(degraded.map((c) => c.name), "parts")} ${degraded.length === 1 ? "isn’t" : "aren’t"} operational`
        : (page.description ?? "Not all operational");
    const word = WORDS[impact];
    // Short enough that how long it's been still fits on the row.
    const subtitle = joinLine(
      clip(what, 48),
      incidents.length > 1 && `+${incidents.length - 1} more`,
      lead?.status === "monitoring" && "recovering",
      age(lead?.startedAt, now),
    );
    return {
      item: { id, title, subtitle, state: stateFor(impact, alertFor), value: word ? text(word) : undefined, url: (lead && incidentURL(page, lead)) ?? pageURL },
      headline: `${title}: ${clip(what, 64)}`,
    };
  }

  const resolved = memory.resolved;
  if (resolved && now.getTime() - Date.parse(resolved.at) < RESOLVED_FOR_MS) {
    return {
      item: { id, title, subtitle: clip(resolved.name, 60), state: "success", value: text("Resolved"), url: resolved.url ?? pageURL },
      headline: `${title}: resolved`,
    };
  }
  const watching = watch.parts.length > 0 ? watch.parts.join(", ") : undefined;
  return { item: { id, title, subtitle: joinLine("Operational", watching), url: pageURL } };
}

/** Notes what's showing, and when trouble that alerted clears, so the row can say it's resolved. */
export function remember(previous: WatchMemory, assessment: Assessment, page: PageStatus, alertFor: AlertFor, now: Date): WatchMemory {
  const { impact, incidents, degraded } = assessment;
  if (assessment.unknownParts.length > 0) return {};
  if (impact !== "none") {
    const lead = incidents[0];
    return { open: { name: lead?.name ?? degraded.map((c) => c.name).join(", "), impact, url: (lead && incidentURL(page, lead)) ?? page.url } };
  }
  const was = previous.open ? stateFor(previous.open.impact, alertFor) : undefined;
  if (previous.open && (was === "failure" || was === "attention")) {
    return { resolved: { name: previous.open.name, at: now.toISOString(), url: previous.open.url } };
  }
  const resolved = previous.resolved && now.getTime() - Date.parse(previous.resolved.at) < RESOLVED_FOR_MS ? previous.resolved : undefined;
  return resolved ? { resolved } : {};
}

const URGENCY: Record<string, number> = { failure: 0, attention: 1, success: 2, offline: 4 };
const urgency = (item: ListItem) => (item.state ? (URGENCY[item.state] ?? 4) : 4);

/** The one blip: every watched page, what's wrong first. */
export function statusBlip(reports: readonly PageReport[], options: { staleAfter: string }): BlipInput {
  const items = reports.map((r) => r.item).sort((a, b) => urgency(a) - urgency(b));
  const base = { key: "status", title: "Status", icon: "waveform.path.ecg", staleAfter: options.staleAfter };
  if (items.length === 0) {
    return list({ ...base, subtitle: "Add a status page in Settings", state: "empty", items: [] });
  }

  // The blip is as loud as its loudest page; a page that can't be reached doesn't dim the rest.
  const top = items.find((item) => item.state && item.state !== "offline");
  const state: BlipState = top?.state ?? "idle";
  const same = top ? reports.filter((r) => r.item.state === state) : [];
  const quiet = items.filter((item) => item.value);
  const subtitle = !top
    ? quiet.length > 0
      ? `${quiet.every((item) => (item.value as { value?: string }).value === "Maintenance") ? "Maintenance" : "Minor trouble"} at ${names(quiet.map((item) => item.title), "pages")}`
      : "All operational"
    : same.length === 1
      ? (same[0].headline ?? `${same[0].item.title}: ${same[0].item.subtitle ?? ""}`)
      : `${state === "success" ? "Resolved at" : "Trouble at"} ${names(same.map((r) => r.item.title), "pages")}`;

  return list({
    ...base,
    subtitle,
    state,
    items: items.slice(0, 5),
    total: items.length > 5 ? items.length : undefined,
    // The ear names the page in trouble, or counts them; how many pages are watched isn't news.
    value: !top ? text("OK") : same.length === 1 ? text(same[0].item.title) : number(same.length),
    url: same.length === 1 ? same[0].item.url : undefined,
  });
}
