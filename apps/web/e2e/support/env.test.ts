// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { E2E_PATIENT } from "../lib/plan";
import {
  appUrl,
  assertWritableEnv,
  awsDefaults,
  baseUrlFor,
  e2eEnv,
  fixtureLogin,
  patientLogin,
} from "./env";

// Synthetic values only; never a real password.
const FROM_ENV = "Synthetic-From-Env-1";
const FROM_FILE = "Synthetic-From-File-2";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-e2e-env-test-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("e2eEnv", () => {
  it("defaults to e2e and takes E2E_ENV", () => {
    vi.stubEnv("E2E_ENV", undefined);
    expect(e2eEnv()).toBe("e2e");
    vi.stubEnv("E2E_ENV", "pr40");
    expect(e2eEnv()).toBe("pr40");
  });

  it("refuses a name deploy.sh wouldn't accept", () => {
    vi.stubEnv("E2E_ENV", "E2E; rm");
    expect(() => e2eEnv()).toThrow("invalid E2E_ENV: E2E; rm");
  });
});

describe("assertWritableEnv", () => {
  it("refuses the shared dev and demo envs", () => {
    expect(() => assertWritableEnv("dev")).toThrow("don't run against the shared 'dev' env");
    expect(() => assertWritableEnv("demo")).toThrow("don't run against the shared 'demo' env");
  });

  it("allows e2e and other envs", () => {
    expect(() => assertWritableEnv("e2e")).not.toThrow();
    expect(() => assertWritableEnv("pr40")).not.toThrow();
  });
});

describe("awsDefaults", () => {
  it("defaults an unset AWS_PROFILE and AWS_REGION to sched-dev and us-east-1", () => {
    vi.stubEnv("AWS_PROFILE", undefined);
    vi.stubEnv("AWS_REGION", undefined);
    awsDefaults();
    expect(process.env.AWS_PROFILE).toBe("sched-dev");
    expect(process.env.AWS_REGION).toBe("us-east-1");
  });

  it("keeps an AWS_PROFILE set but empty, as e2e.yml sets it (r1/A-1)", () => {
    vi.stubEnv("AWS_PROFILE", "");
    awsDefaults();
    expect(process.env.AWS_PROFILE).toBe("");
  });

  it("keeps a profile and region that are set", () => {
    vi.stubEnv("AWS_PROFILE", "other");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    awsDefaults();
    expect(process.env.AWS_PROFILE).toBe("other");
    expect(process.env.AWS_REGION).toBe("eu-west-1");
  });
});

describe("URLs", () => {
  it("takes E2E_BASE_URL without a trailing slash, before SSM", async () => {
    vi.stubEnv("E2E_BASE_URL", "https://example.test//");
    await expect(baseUrlFor("e2e")).resolves.toBe("https://example.test");
  });

  it("builds app URLs from E2E_BASE_URL, and refuses without it", () => {
    vi.stubEnv("E2E_BASE_URL", "https://example.test");
    expect(appUrl("/chat")).toBe("https://example.test/chat");
    vi.stubEnv("E2E_BASE_URL", "");
    expect(() => appUrl("/chat")).toThrow("E2E_BASE_URL is not set");
  });
});

describe("logins", () => {
  const envFile = () => {
    const file = join(dir, ".env");
    writeFileSync(file, `DEMO_PASSWORD_SOFIA=${FROM_FILE}\nDEMO_PASSWORD_MARIA=${FROM_FILE}\n`);
    return file;
  };
  const mapping = (alias: keyof typeof FIXTURE_PATIENT_IDS) => {
    const file = join(dir, "cognito-users.e2e.json");
    const user = { alias, fixturePatientId: FIXTURE_PATIENT_IDS[alias], username: "user.name", sub: "sub-1" };
    writeFileSync(
      file,
      JSON.stringify({ env: "e2e", userPoolId: "pool", updatedAt: "2026-10-13", users: [user] }),
    );
    return file;
  };

  it("signs Sofia in on e2e (r1/Q-1 (a))", () => {
    expect(E2E_PATIENT).toBe("pat-sofia");
    vi.stubEnv("DEMO_PASSWORD_SOFIA", undefined);
    expect(patientLogin("e2e", { mapping: mapping("pat-sofia"), envFile: envFile() })).toEqual({
      alias: "pat-sofia",
      username: "user.name",
      sub: "sub-1",
      password: FROM_FILE,
      firstName: "Sofia",
    });
  });

  it("takes the password from the environment before the .env file", () => {
    vi.stubEnv("DEMO_PASSWORD_SOFIA", FROM_ENV);
    expect(patientLogin("e2e", { mapping: mapping("pat-sofia"), envFile: envFile() }).password).toBe(
      FROM_ENV,
    );
  });

  it("refuses a mapping without Sofia's row", () => {
    vi.stubEnv("DEMO_PASSWORD_SOFIA", FROM_ENV);
    expect(() => patientLogin("e2e", { mapping: mapping("pat-maria"), envFile: envFile() })).toThrow(
      "No pat-sofia row in",
    );
  });

  it("names the variable, never a value, when neither source has the password", () => {
    vi.stubEnv("DEMO_PASSWORD_SOFIA", undefined);
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "SES_SENDER=x\n");
    expect(() => patientLogin("e2e", { mapping: mapping("pat-sofia"), envFile: empty })).toThrow(
      `DEMO_PASSWORD_SOFIA is not set (environment, or ${empty})`,
    );
    expect(() => fixtureLogin("pat-sofia", { envFile: join(dir, "missing.env") })).toThrow(
      "DEMO_PASSWORD_SOFIA is not set",
    );
  });

  it("signs a fixture patient in as <first>.<last>, greeted by first name", () => {
    vi.stubEnv("DEMO_PASSWORD_MARIA", undefined);
    expect(fixtureLogin("pat-maria", { envFile: envFile() })).toEqual({
      username: "maria.santos",
      password: FROM_FILE,
      firstName: "Maria",
    });
  });
});
