import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

export const GSI1 = "GSI1";

/**
 * The table definition from `infra/stacks/data.yaml` as a CreateTable input, for DynamoDB Local (tests,
 * local dev). The deployed table always comes from CloudFormation. `test/dynamo/table.test.ts` checks
 * that the two stay in step.
 */
export function createTableInput(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
      { AttributeName: "GSI1PK", AttributeType: "S" },
      { AttributeName: "GSI1SK", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI1,
        KeySchema: [
          { AttributeName: "GSI1PK", KeyType: "HASH" },
          { AttributeName: "GSI1SK", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };
}
