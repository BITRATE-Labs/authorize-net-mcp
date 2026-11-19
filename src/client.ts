import { asObject, type BuildContext, type Operation } from "./operation.js";

type Payload = Record<string, unknown>;
type NumberSource = { source?: string };
export type Environment = "sandbox" | "production";
const hosts: Record<Environment, string> = {
  sandbox: "apitest.authorize.net",
  production: "api.authorize.net",
};

const maxResponseBytes = 2 * 1024 * 1024;
const maxRequestBytes = 64 * 1024;
const maxResultBytes = 128 * 1024;
const restPath = /^\/rest\/v1\/(?:eventtypes|webhooks(?:\/[a-f0-9-]{36}(?:\/pings)?)?|notifications(?:\/[a-f0-9-]{36})?)(?:\?[^#]*)?$/i;
const authFailureCodes = new Set(["E00005", "E00006", "E00007", "E00008"]);
const processingErrorCodes = new Set(["E00001", "E00027", "E00049"]);

export type ErrorCode =
  | "invalid_input" | "unavailable" | "write_disabled" | "provider_rejected"
  | "credentials_rejected" | "provider_unavailable" | "invalid_response" | "completion_unknown";

export class ClientError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly providerCode?: string) {
    super(providerCode ? `${message} [${providerCode}]` : message);
    this.name = "ClientError";
  }
}

interface ClientConfig {
  environment: Environment;
  apiLoginId: string;
  transactionKey: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  allowWrites?: boolean;
  webhookOrigin?: string;
  hostedReturnOrigin?: string;
}

function encode(value: unknown): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > maxRequestBytes) {
    throw new ClientError("invalid_input", "The request exceeds the permitted size.");
  }
  return body;
}

async function decode(response: Response): Promise<unknown> {
  if (response.status === 204 || response.body === null) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let json = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("Response limit exceeded.");
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    return json === "" ? {} : JSON.parse(json, preserveProviderNumbers);
  } finally {
    reader.releaseLock();
  }
}

function preserveProviderNumbers(key: string, value: unknown, context?: NumberSource): unknown {
  if (typeof value !== "number") return value;
  const source = context?.source;
  if (/(?:^id$|id$)/i.test(key) && /^\d+$/.test(source ?? String(value))) {
    if (source === undefined && !Number.isSafeInteger(value)) throw new Error("Unsafe provider ID.");
    return source ?? String(value);
  }
  if (/(?:amount|price|fee|balance)$/i.test(key)) {
    const decimal = source ?? String(value);
    if (!/^-?\d+(?:\.\d+)?$/.test(decimal)) throw new Error("Unexpected provider decimal.");
    return decimal;
  }
  return value;
}

function transactionWithOutcome(body: Payload): boolean {
  const response = body.transactionResponse;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const result = response as Payload;
  return ["1", "2", "4"].includes(String(result.responseCode))
    && typeof result.transId === "string"
    && /^[0-9]+$/.test(result.transId)
    && result.transId !== "0";
}

function gatewayResult(body: unknown, requestName: string, writes: boolean): Payload {
  const envelope = asObject(body);
  const wrapper = `${requestName.slice(0, -"Request".length)}Response`;
  const result = Object.hasOwn(envelope, wrapper) && !Object.hasOwn(envelope, "messages")
    ? asObject(envelope[wrapper]) : envelope;
  const messages = asObject(result.messages);
  if (messages.resultCode === "Ok") {
    if (writes && requestName === "createTransactionRequest" && !transactionWithOutcome(result)) {
      throw new Error("The transaction response lacks a confirmed outcome.");
    }
    return result;
  }
  if (messages.resultCode !== "Error" || !Array.isArray(messages.message)) {
    throw new Error("Malformed gateway result.");
  }
  const providerCode = messages.message
    .map((entry: unknown) => asObject(entry).code)
    .find((code: unknown): code is string => typeof code === "string" && /^[EI]\d{5}$/.test(code));
  if (providerCode && authFailureCodes.has(providerCode)) {
    throw new ClientError("credentials_rejected", "Authorize.net rejected the merchant credentials.", providerCode);
  }
  if (transactionWithOutcome(result)) return result;
  if (!providerCode) throw new Error("Missing gateway error code.");
  if (writes && processingErrorCodes.has(providerCode)) throw uncertain(true);
  throw new ClientError("provider_rejected", "Authorize.net rejected this request.", providerCode);
}

function uncertain(writes: boolean): ClientError {
  return writes
    ? new ClientError("completion_unknown", "The provider may have received the write. Reconcile its state before another submission.")
    : new ClientError("provider_unavailable", "The Authorize.net request did not complete.");
}

export function createClient(config: ClientConfig) {
  if (!Object.hasOwn(hosts, config.environment) || !config.apiLoginId || !config.transactionKey) {
    throw new ClientError("credentials_rejected", "A Sandbox or Production merchant connection is required.");
  }
  const origin = `https://${hosts[config.environment]}`;
  const auth = { name: config.apiLoginId, transactionKey: config.transactionKey };

  async function request(
    path: string, init: RequestInit, writes: boolean, requestName?: string,
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(15_000);
    const signal = config.signal ? AbortSignal.any([config.signal, deadline]) : deadline;
    if (signal.aborted) {
      throw new ClientError("provider_unavailable", "The request was canceled before dispatch.");
    }
    let response: Response;
    try {
      response = await config.fetch(`${origin}${path}`, { ...init, redirect: "manual", signal });
    } catch {
      throw uncertain(writes);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) {
        throw new ClientError("credentials_rejected", "Authorize.net rejected the merchant credentials.");
      }
      if (!requestName && [400, 403, 404, 405, 422].includes(response.status)) {
        throw new ClientError("provider_rejected", `Authorize.net rejected this request (HTTP ${response.status}).`);
      }
      throw uncertain(writes);
    }
    try {
      const value = await decode(response);
      return requestName ? gatewayResult(value, requestName, writes) : value;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (writes) throw uncertain(true);
      throw new ClientError("invalid_response", "Authorize.net returned an unexpected response.");
    }
  }

  async function requestGateway(name: string, body: Payload, writes: boolean): Promise<Payload> {
    if (!/^[A-Za-z][A-Za-z0-9]*Request$/.test(name) || Object.hasOwn(body, "merchantAuthentication")) {
      throw new ClientError("invalid_input", "The operation request is invalid.");
    }
    const result = await request("/xml/v1/request.api", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: encode({ [name]: { merchantAuthentication: auth, ...body } }),
    }, writes, name);
    return asObject(result);
  }

  async function requestRest(
    method: "GET" | "POST" | "PUT" | "DELETE", path: string, body: Payload | undefined, writes: boolean,
  ): Promise<Payload> {
    if (!restPath.test(path) || (method === "GET") === writes) {
      throw new ClientError("invalid_input", "The operation route is invalid.");
    }
    const result = await request(path, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${auth.name}:${auth.transactionKey}`)}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : encode(body),
    }, writes);
    if (Array.isArray(result)) return { items: result };
    return asObject(result);
  }

  const context: BuildContext = {
    webhookOrigin: config.webhookOrigin,
    hostedReturnOrigin: config.hostedReturnOrigin,
    readTransaction: async (transId) =>
      asObject((await requestGateway("getTransactionDetailsRequest", { transId }, false)).transaction),
    readPaypal: async (refTransId) => asObject((await requestGateway("createTransactionRequest", {
      transactionRequest: { transactionType: "getDetailsTransaction", refTransId },
    }, false)).transactionResponse),
    readSubscription: async (subscriptionId) =>
      asObject((await requestGateway("ARBGetSubscriptionRequest", { subscriptionId, includeTransactions: true }, false)).subscription),
    readCustomerProfile: async (customerProfileId) =>
      asObject((await requestGateway("getCustomerProfileRequest", { customerProfileId }, false)).profile),
    readWebhook: (id) => requestRest("GET", `/rest/v1/webhooks/${id}`, undefined, false),
  };

  return {
    async authenticate() {
      await requestGateway("authenticateTestRequest", {}, false);
    },
    async execute(operation: Operation, args: unknown): Promise<Payload> {
      if (operation.status === "unavailable") {
        throw new ClientError("unavailable", operation.reason);
      }
      const writes = operation.kind === "write";
      if (writes && config.allowWrites !== true) {
        throw new ClientError("write_disabled", "This invocation is not authorized to write.");
      }

      const parsed = operation.input.safeParse(args);
      if (!parsed.success) {
        throw new ClientError("invalid_input", "Arguments do not match the operation schema.");
      }
      let wire;
      try {
        wire = await operation.build(parsed.data, context);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new ClientError("invalid_input", "The operation failed its preflight checks.");
      }
      const response = wire.family === "gateway"
        ? await requestGateway(wire.name, wire.body, writes)
        : await requestRest(wire.method, wire.path, wire.body, writes);
      try {
        const projected = operation.project(response, parsed.data);
        if (new TextEncoder().encode(JSON.stringify(projected)).length > maxResultBytes) {
          throw new Error("Result limit exceeded.");
        }
        return projected;
      } catch {
        if (writes) throw uncertain(true);
        throw new ClientError("invalid_response", "The provider result exceeded the operation output contract.");
      }
    },
  };
}
