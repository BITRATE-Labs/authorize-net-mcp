import { z } from "zod";
import { ClientError } from "./client.js";
import type { Operation } from "./operation.js";
import { accounts } from "./operations/accounts.js";
import { reporting } from "./operations/reporting.js";
import { transactions } from "./operations/transactions.js";
import { webhooks } from "./operations/webhooks.js";

export const operations: readonly Operation[] = [...reporting, ...transactions, ...accounts, ...webhooks];
const byId = new Map(operations.map((operation) => [operation.id, operation]));
if (byId.size !== operations.length) throw new Error("The operation catalog contains duplicate IDs.");

export function getOperation(id: string): Operation {
  const operation = byId.get(id);
  if (!operation) throw new ClientError("invalid_input", "Unknown operation. Use list_operations to find an operation ID.");
  return operation;
}

function summary(operation: Operation) {
  const { id, title, kind, request, status } = operation;
  return { id, title, kind, request, status };
}

export function listOperations() {
  return operations.map(summary);
}

export function describeOperation(id: string) {
  const operation = getOperation(id);
  return operation.status === "available"
    ? { ...summary(operation), status: operation.status, input: z.toJSONSchema(operation.input, { io: "input" }) }
    : { ...summary(operation), status: operation.status, reason: operation.reason };
}
