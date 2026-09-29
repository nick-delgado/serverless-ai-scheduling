import type { Provider } from "@sched/contracts";

const HONORIFICS = new Set(["dr", "doctor"]);

function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "José" matches "jose"
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Does a name as a patient says it ("Lee", "Dr. Okafor", "priya lee") refer to this provider?
 * Case- and accent-insensitive; honorifics are ignored; every remaining word must be a prefix of the
 * provider's first or last name. A query that is only an honorific matches everyone.
 *
 * Shared by the in-memory and DynamoDB repositories so name search behaves identically in both.
 */
export function providerMatchesName(
  provider: Pick<Provider, "firstName" | "lastName">,
  query: string,
): boolean {
  const wanted = words(query).filter((w) => !HONORIFICS.has(w));
  const names = words(`${provider.firstName} ${provider.lastName}`);
  return wanted.every((w) => names.some((n) => n.startsWith(w)));
}

/** Provider sort order: ADR-004's GSI1SK `<specialty>#<lastName>`, then providerId for a stable tiebreak. */
export function compareProviders(a: Provider, b: Provider): number {
  const ka = `${a.specialty}#${a.lastName}`;
  const kb = `${b.specialty}#${b.lastName}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}
