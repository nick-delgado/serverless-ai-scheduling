/** AC4's scope check (#29) against a mocked `@aws-sdk/client-transcribe`. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state: { outcome: unknown; destroyed: number; sent: unknown[]; config: unknown } = {
    outcome: undefined,
    destroyed: 0,
    sent: [],
    config: undefined,
  };
  class TranscribeClient {
    constructor(config: unknown) {
      state.config = config;
    }
    send(command: unknown) {
      state.sent.push(command);
      return state.outcome instanceof Error ? Promise.reject(state.outcome) : Promise.resolve({});
    }
    destroy() {
      state.destroyed += 1;
    }
  }
  class ListTranscriptionJobsCommand {
    constructor(readonly input: unknown) {}
  }
  return { state, TranscribeClient, ListTranscriptionJobsCommand };
});

vi.mock("@aws-sdk/client-transcribe", () => ({
  TranscribeClient: sdk.TranscribeClient,
  ListTranscriptionJobsCommand: sdk.ListTranscriptionJobsCommand,
}));

import { FAKE_AWS_CREDENTIALS } from "../../auth/testing";
import { checkRoleScope, ROLE_CHECK_ACTION } from "./roleCheck";

const AT = new Date("2026-10-09T12:00:00Z");
const awsError = (name: string, status?: number) =>
  Object.assign(new Error("message"), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

beforeEach(() => {
  sdk.state.outcome = undefined;
  sdk.state.destroyed = 0;
  sdk.state.sent = [];
});

describe("checkRoleScope", () => {
  it("calls ListTranscriptionJobs with the voice credentials, and records a denial", async () => {
    sdk.state.outcome = awsError("AccessDeniedException", 400);
    await expect(checkRoleScope("us-east-1", FAKE_AWS_CREDENTIALS, AT)).resolves.toEqual({
      at: "2026-10-09T12:00:00.000Z",
      action: ROLE_CHECK_ACTION,
      denied: true,
      result: "AccessDeniedException (HTTP 400)",
    });
    expect(sdk.state.config).toEqual({ region: "us-east-1", credentials: FAKE_AWS_CREDENTIALS });
    expect(sdk.state.sent[0]).toBeInstanceOf(sdk.ListTranscriptionJobsCommand);
    expect(sdk.state.destroyed).toBe(1);
  });

  it("records a role that allows the call as not denied", async () => {
    await expect(checkRoleScope("us-east-1", FAKE_AWS_CREDENTIALS, AT)).resolves.toMatchObject({
      denied: false,
      result: expect.stringMatching(/ALLOWED/),
    });
  });

  it("records any other failure as not a denial", async () => {
    sdk.state.outcome = awsError("TypeError");
    await expect(checkRoleScope("us-east-1", FAKE_AWS_CREDENTIALS, AT)).resolves.toMatchObject({
      denied: false,
      result: "TypeError",
    });
  });
});
