/**
 * The status API behind most status pages, public and keyless. Atlassian Statuspage serves
 * it (GitHub, Claude, Cloudflare, Vercel), and incident.io's pages answer in the same shape
 * (OpenAI), though with less: no unresolved-incidents list, no component groups, and no
 * word on which components an incident touches. Everything here reads leniently.
 *
 * - `/api/v2/status.json`: the page's name, its overall indicator and when it last
 *   changed. About 200 bytes, so it's the one looked at every time.
 * - `/api/v2/incidents/unresolved.json`: what's open now (Statuspage only).
 * - `/api/v2/summary.json`: all of it, components included. Only fetched for a page watched
 *   in parts, or one without the list above: Cloudflare's lists 480 data centres, 258 KB.
 */

/** How bad, in Statuspage's own scale. Maintenance is planned, so it ranks below any trouble. */
export type Impact = "none" | "maintenance" | "minor" | "major" | "critical";

export const RANK: Record<Impact, number> = { none: 0, maintenance: 1, minor: 2, major: 3, critical: 4 };

export interface Component {
  id: string;
  name: string;
  /** `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`. */
  status: string;
  groupId?: string;
  isGroup: boolean;
}

export interface Incident {
  id: string;
  name: string;
  /** `investigating`, `identified`, `monitoring`. */
  status: string;
  impact: Impact;
  startedAt?: string;
  url?: string;
  /** The components it names, by id. Undefined when the page doesn't say. */
  componentIds?: string[];
}

/** From `status.json`: who the page is and how it says it's doing. */
export interface PageSummary {
  /** "Cloudflare", not "Cloudflare Status". */
  name: string;
  url: string;
  indicator: Impact;
  /** The page's own words: "Partial System Degradation". */
  description?: string;
  /** Changes whenever anything on the page does. */
  updatedAt?: string;
}

export interface PageStatus extends PageSummary {
  /** Unresolved incidents. */
  incidents: Incident[];
  /** Only fetched when parts of the page are watched; empty otherwise. */
  components: Component[];
}

export function apiURL(page: URL, path: "status" | "incidents/unresolved" | "summary"): string {
  return new URL(`/api/v2/${path}.json`, page.origin).href;
}

/** Where an incident reads in full: its short link, or `/incidents/<id>`, which both kinds of page serve. */
export function incidentURL(page: PageSummary, incident: Incident): string | undefined {
  if (incident.url) return incident.url;
  try {
    return new URL(`/incidents/${encodeURIComponent(incident.id)}`, page.url).href;
  } catch {
    return undefined;
  }
}

/** A component's status on the impact scale. */
export function componentImpact(status: string): Impact {
  switch (status) {
    case "degraded_performance":
      return "minor";
    case "partial_outage":
      return "major";
    case "major_outage":
      return "critical";
    case "under_maintenance":
      return "maintenance";
    default:
      return "none";
  }
}

/** `status.json`, or undefined for anything that isn't one (a web page, another API). */
export function parseStatus(body: unknown): PageSummary | undefined {
  if (!isObject(body) || !isObject(body.page) || !isObject(body.status)) return undefined;
  const name = string(body.page.name);
  if (!name) return undefined;
  return {
    name: name.replace(/\s+status$/i, "") || name,
    url: string(body.page.url) ?? "",
    indicator: impact(body.status.indicator),
    description: string(body.status.description),
    updatedAt: string(body.page.updated_at),
  };
}

/** The open incidents in `incidents/unresolved.json` or `summary.json`. */
export function parseIncidents(body: unknown): Incident[] | undefined {
  if (!isObject(body) || !Array.isArray(body.incidents)) return undefined;
  return array(body.incidents).flatMap((raw): Incident[] => {
    const id = string(raw.id);
    const name = string(raw.name);
    const status = string(raw.status) ?? "investigating";
    if (!id || !name || status === "resolved" || status === "postmortem") return [];
    return [
      {
        id,
        name,
        status,
        impact: impact(raw.impact),
        startedAt: string(raw.started_at) ?? string(raw.created_at),
        url: string(raw.shortlink),
        componentIds: Array.isArray(raw.components) ? array(raw.components).flatMap((c) => string(c.id) ?? []) : undefined,
      },
    ];
  });
}

/** The components in `summary.json`. */
export function parseComponents(body: unknown): Component[] {
  if (!isObject(body)) return [];
  return array(body.components).flatMap((raw): Component[] => {
    const id = string(raw.id);
    const name = string(raw.name);
    if (!id || !name) return [];
    return [{ id, name, status: string(raw.status) ?? "operational", groupId: string(raw.group_id), isGroup: raw.group === true }];
  });
}

/** A whole `summary.json` at once, for tests and pages read in one go. */
export function parseSummary(body: unknown): PageStatus | undefined {
  const summary = parseStatus(body);
  if (!summary) return undefined;
  return { ...summary, incidents: parseIncidents(body) ?? [], components: parseComponents(body) };
}

function impact(value: unknown): Impact {
  return value === "minor" || value === "major" || value === "critical" || value === "maintenance" ? value : "none";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
