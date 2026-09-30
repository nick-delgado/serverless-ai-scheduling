/**
 * The test tables must match the deployed one. `createTableInput` mirrors `infra/stacks/data.yaml`; this
 * check fails if either side drifts (keys, GSI1, projection). Runs without DynamoDB Local.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createTableInput } from "../../src/repos/dynamo/table";

const template = readFileSync(new URL("../../../../infra/stacks/data.yaml", import.meta.url), "utf8");

describe("createTableInput matches infra/stacks/data.yaml", () => {
  const input = createTableInput("t");

  it("declares the same attributes and key schema", () => {
    for (const a of input.AttributeDefinitions ?? []) {
      expect(template).toContain(`{ AttributeName: ${a.AttributeName}, AttributeType: ${a.AttributeType} }`);
    }
    for (const k of input.KeySchema ?? []) {
      expect(template).toContain(`{ AttributeName: ${k.AttributeName}, KeyType: ${k.KeyType} }`);
    }
  });

  it("declares GSI1 with the same keys and projection", () => {
    const gsi = input.GlobalSecondaryIndexes?.[0];
    expect(gsi?.IndexName).toBe("GSI1");
    expect(template).toContain("IndexName: GSI1");
    for (const k of gsi?.KeySchema ?? []) {
      expect(template).toContain(`{ AttributeName: ${k.AttributeName}, KeyType: ${k.KeyType} }`);
    }
    expect(template).toContain(`ProjectionType: ${gsi?.Projection?.ProjectionType ?? "?"}`);
    expect(template.match(/IndexName:/g)).toHaveLength(input.GlobalSecondaryIndexes?.length ?? 0);
  });

  it("uses on-demand billing, TTL on expiresAt, and PITR (ADR-004)", () => {
    expect(template).toContain("BillingMode: PAY_PER_REQUEST");
    expect(template).toMatch(/TimeToLiveSpecification:\s+AttributeName: expiresAt\s+Enabled: true/);
    expect(template).toContain("PointInTimeRecoveryEnabled: true");
  });
});
