import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { queryAll } from "../src/lib/query-all";

const input = { TableName: "t", KeyConditionExpression: "PK = :p" };

describe("queryAll", () => {
  it("follows LastEvaluatedKey page by page and returns every item in order", async () => {
    const pages = [
      { Items: [{ n: 1 }], LastEvaluatedKey: { PK: "k1" } },
      { Items: [{ n: 2 }, { n: 3 }], LastEvaluatedKey: { PK: "k2" } },
      { Items: [{ n: 4 }] },
    ];
    const sent: QueryCommand[] = [];
    const doc = {
      send: (command: QueryCommand) => {
        sent.push(command);
        return Promise.resolve(pages.shift());
      },
    } as never;

    expect(await queryAll(doc, input)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(sent.map((c) => c.input.ExclusiveStartKey)).toEqual([undefined, { PK: "k1" }, { PK: "k2" }]);
    expect(sent.every((c) => c.input.TableName === "t")).toBe(true);
  });

  it("reads a page with no Items as empty", async () => {
    const doc = { send: () => Promise.resolve({}) } as never;
    expect(await queryAll(doc, input)).toEqual([]);
  });
});
