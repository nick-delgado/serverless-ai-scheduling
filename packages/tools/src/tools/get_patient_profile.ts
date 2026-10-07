/**
 * get_patient_profile (FR-033, FR-037): the logged-in patient's name and preferred provider.
 * Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1).
 * Only what the output schema asks for is returned: no date of birth or other PII (ADR-009).
 */
import { toolFail, toolOk, type ToolHandler } from "../handler";
import { toProviderSummary } from "./summaries";

export const getPatientProfile: ToolHandler<"get_patient_profile"> = async (_input, ctx) => {
  const patient = await ctx.repos.patients.get(ctx.patientId);
  if (!patient) {
    return toolFail(
      "NOT_FOUND",
      "No profile is on file for the logged-in patient.",
      "Continue without the patient's name. If they need their profile, offer to connect them with the front desk.",
    );
  }

  // A preferred provider that no longer exists is not an error: the profile is still useful without it.
  const preferred = patient.preferredProviderId
    ? await ctx.repos.providers.get(patient.preferredProviderId)
    : null;

  return toolOk({
    first_name: patient.firstName,
    last_name: patient.lastName,
    preferred_provider: preferred ? toProviderSummary(preferred) : null,
  });
};
