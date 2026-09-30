/**
 * The pages to watch, from the "Status pages" option: one per line, its address, then
 * the parts to watch if not all of it.
 *
 *   https://status.claude.com Claude Code, Claude API
 *   https://www.githubstatus.com
 *
 * The address needs its https://: the manifest's `{pages}` grants the host of each URL
 * typed there, and a bare host isn't a URL.
 */

export interface Watch {
  /** What was typed, for naming it when it's wrong. */
  address: string;
  url?: URL;
  /** Component names; empty for the whole page. */
  parts: string[];
  /** Why it can't be watched, in words for the notch. */
  problem?: string;
}

export function parsePages(text: string): Watch[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [address, ...rest] = line.split(/\s+/);
      const parts = rest
        .join(" ")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      try {
        const url = new URL(address);
        if (url.protocol === "https:" || url.protocol === "http:") return { address, url, parts };
      } catch {}
      const looksLikeHost = /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(address);
      return { address, parts, problem: looksLikeHost ? `Type it as https://${address}` : `“${address}” isn’t an address` };
    });
}

/** Stable across runs, and different for the same page watched for different parts. */
export function watchID(watch: Watch): string {
  const where = watch.url?.host ?? watch.address;
  return watch.parts.length > 0 ? `${where}#${watch.parts.join(",").toLowerCase()}` : where;
}
