/**
 * find_providers (FR-030): list Cedar Ridge Health providers, optionally by specialty and/or part of a name.
 *
 * AP-3: `providers.list` queries the providers index (by specialty when given) and applies the name
 * filter in code with `providerMatchesName` ("Dr. Lee", "lee", "Okafor" all resolve). The repo order
 * (specialty, last name, providerId) is stable, so the model sees the same list for the same question.
 *
 * No patient data is read. An empty list is a success, not an error: "nobody matches" is an answer.
 */
import { LIMITS, type Provider, type ProviderSummary } from "@sched/contracts";

import { toolOk, type ToolHandler } from "../registry";

const toProviderSummary = (p: Provider): ProviderSummary => ({
  provider_id: p.providerId,
  display_name: p.displayName,
  specialty: p.specialty,
  accepting_new_patients: p.acceptingNewPatients,
});

export const findProviders: ToolHandler<"find_providers"> = async (input, ctx) => {
  const providers = await ctx.repos.providers.list({
    ...(input.specialty !== undefined && { specialty: input.specialty }),
    ...(input.name_query !== undefined && { nameQuery: input.name_query }),
  });
  return toolOk({
    providers: providers.slice(0, LIMITS.providersMaxResults).map(toProviderSummary),
  });
};
