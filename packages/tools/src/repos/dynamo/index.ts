/**
 * DynamoDB repositories (#13), a separate entry point so the in-memory/eval import graph never loads the
 * AWS SDK: `import { createDynamoRepositories } from "@sched/tools/dynamo"`.
 */
export {
  BATCH_WRITE_MAX_CALLS,
  batchWrite,
  type BatchWriteRequest,
  createDocumentClient,
  createDynamoRepositories,
  writeSeed,
  type DynamoRepositoryOptions,
} from "./repositories";
export { createTableInput, GSI1 } from "./table";
export { escalationFrom, keys, MESSAGE_TTL_DAYS } from "./items";
