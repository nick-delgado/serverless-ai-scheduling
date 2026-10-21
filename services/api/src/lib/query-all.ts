/**
 * Every item a `Query` returns, following `LastEvaluatedKey` page by page. `doc` needs only `send`, so tests can pass
 * a fake (the SDK's own paginator insists on a real document client).
 */
import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";

export async function queryAll(
  doc: Pick<DynamoDBDocumentClient, "send">,
  input: QueryCommandInput,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}
