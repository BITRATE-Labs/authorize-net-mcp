import { z } from "zod";

export type OperationKind = "read" | "write";
export class PreflightError extends Error {}
type Payload = Record<string, unknown>;
export type Projection =
  | true
  | { readonly [key: string]: Projection }
  | readonly [Projection]
  | ((value: unknown) => unknown);

export interface BuildContext {
  webhookOrigin?: string;
  hostedReturnOrigin?: string;
  readTransaction(id: string): Promise<Payload>;
  readPaypal(id: string): Promise<Payload>;
  readSubscription(id: string): Promise<Payload>;
  readCustomerProfile(id: string): Promise<Payload>;
  readWebhook(id: string): Promise<Payload>;
}

interface Metadata {
  id: string;
  title: string;
  kind: OperationKind;
  request: string;
}

type WireRequest =
  | { family: "gateway"; name: string; body: Payload }
  | { family: "rest"; method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: Payload };

export type Operation =
  | (Metadata & { status: "unavailable"; reason: string })
  | (Metadata & {
      status: "available";
      input: z.ZodType;
      parse(input: unknown): unknown;
      build(input: unknown, context: BuildContext): Promise<WireRequest>;
      project(response: unknown, input: unknown): Payload;
    });

interface Definition<T extends z.ZodType> {
  id: string;
  title: string;
  kind: OperationKind;
  input: T;
  output: Projection;
  transform?: (response: Payload, input: z.output<T>) => Payload;
}

export function asObject(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a provider object.");
  }
  return value as Payload;
}

export function canonicalMoney(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

function select(value: unknown, projection: Projection): unknown {
  if (value === undefined) return undefined;
  if (typeof projection === "function") return projection(value);
  if (projection === true) {
    if (typeof value === "string" && value.length <= 4096) return value;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    throw new Error("Unexpected provider field type.");
  }
  if (Array.isArray(projection)) {
    if (!Array.isArray(value)) throw new Error("Expected a provider list.");
    return value.map((entry) => select(entry, projection[0]));
  }
  const record = asObject(value);
  const fields = Object.entries(projection).flatMap(([key, shape]) => {
    if (!Object.hasOwn(record, key)) return [];
    const field = select(record[key], shape);
    return field === undefined ? [] : [[key, field]];
  });
  return Object.fromEntries(fields);
}

function define<T extends z.ZodType>(
  definition: Definition<T>,
  request: string,
  build: (input: z.output<T>, context: BuildContext) => Promise<WireRequest>,
): Operation {
  return {
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    request,
    status: "available",
    input: definition.input,
    parse: (input) => definition.input.parse(input),
    build: (input, context) => build(input as z.output<T>, context),
    project: (body, input) => {
      const projected = asObject(select(body, definition.output));
      return definition.transform?.(projected, input as z.output<T>) ?? projected;
    },
  };
}

export function gateway<T extends z.ZodType>(definition: Definition<T> & {
  request: string;
  build: (input: z.output<T>, context: BuildContext) => Payload | Promise<Payload>;
}): Operation {
  return define(definition, definition.request, async (input, context) => ({
    family: "gateway",
    name: definition.request,
    body: await definition.build(input, context),
  }));
}

export function rest<T extends z.ZodType>(definition: Definition<T> & {
  method: "GET" | "POST" | "PUT" | "DELETE";
  route?: string;
  build: (input: z.output<T>, context: BuildContext) =>
    { path: string; body?: Payload } | Promise<{ path: string; body?: Payload }>;
}): Operation {
  const request = `${definition.method} ${definition.route ?? definition.id}`;
  return define(definition, request, async (input, context) => ({
    family: "rest",
    method: definition.method,
    ...await definition.build(input, context),
  }));
}

export function unavailable(definition: Omit<Metadata, "kind"> & {
  reason: string;
  kind?: OperationKind;
}): Operation {
  return { ...definition, kind: definition.kind ?? "write", status: "unavailable" };
}
