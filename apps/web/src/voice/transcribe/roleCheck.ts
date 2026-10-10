/**
 * AC4's scope check (#29; ADR-006 Validation "Role scoping"), timing builds only: the same Identity
 * Pool credentials that stream must be refused anything else. Calls `transcribe:ListTranscriptionJobs`,
 * as spike S-3 did; `AccessDeniedException` is the expected answer. Only `TimingPanel.tsx` imports
 * this, lazily, so `@aws-sdk/client-transcribe` (a dev dependency) reaches no other build.
 */
import { ListTranscriptionJobsCommand, TranscribeClient } from "@aws-sdk/client-transcribe";

import type { AwsCredentials } from "../../auth/authService";
import { errorName } from "./mic";
import type { RoleCheck } from "./timing";

export const ROLE_CHECK_ACTION = "transcribe:ListTranscriptionJobs";

export async function checkRoleScope(
  region: string,
  credentials: AwsCredentials,
  at: Date,
): Promise<RoleCheck> {
  const client = new TranscribeClient({ region, credentials });
  try {
    await client.send(new ListTranscriptionJobsCommand({ MaxResults: 1 }));
    return {
      at: at.toISOString(),
      action: ROLE_CHECK_ACTION,
      denied: false,
      result: "ALLOWED: the role is too broad",
    };
  } catch (error) {
    const name = errorName(error) || "unknown error";
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return {
      at: at.toISOString(),
      action: ROLE_CHECK_ACTION,
      denied: name === "AccessDeniedException",
      result: status ? `${name} (HTTP ${String(status)})` : name,
    };
  } finally {
    client.destroy();
  }
}
