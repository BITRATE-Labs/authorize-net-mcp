import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeOperation, getOperation, listOperations } from './catalog.js';
import { ClientError, createClient } from './client.js';
import { describeInput, dispatchInput, listInput, parseDispatchInput, readSubscriptionSchedules, scheduleInput } from './tools.js';

const configuredEnvironment = process.env.AUTHORIZE_NET_ENVIRONMENT ?? 'sandbox';
if (configuredEnvironment !== 'sandbox' && configuredEnvironment !== 'production') {
  console.error('AUTHORIZE_NET_ENVIRONMENT must be sandbox or production.');
  process.exit(1);
}
const environment = configuredEnvironment;

const server = new McpServer({ name: 'authorize-net-mcp', version: '0.2.0' });
const annotations = { readOnlyHint: true, openWorldHint: true };

function response(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

async function gatewayRead(read: () => Promise<Record<string, unknown>>) {
  try {
    return response(await read());
  } catch (error) {
    const detail = error instanceof ClientError
      ? { code: error.code, message: error.message, ...(error.providerCode ? { providerCode: error.providerCode } : {}) }
      : { code: 'invalid_input', message: 'The read could not be completed. Check the operation and its input schema.' };
    return { ...response({ environment, error: detail }), isError: true };
  }
}

function merchantClient(signal: AbortSignal) {
  const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY;
  if (!apiLoginId || !transactionKey) {
    throw new ClientError('credentials_rejected', 'Set AUTHORIZE_NET_API_LOGIN_ID and AUTHORIZE_NET_TRANSACTION_KEY to run merchant reads.');
  }
  return createClient({ environment, apiLoginId, transactionKey, fetch: globalThis.fetch, signal });
}

server.registerTool('list_operations', {
  description: 'List Authorize.net read operations and their availability.',
  inputSchema: listInput, annotations,
}, () => response({ operations: listOperations().filter((operation) => operation.kind === 'read') }));

server.registerTool('describe_operation', {
  description: 'Get the exact input schema or prerequisites for an Authorize.net read operation.',
  inputSchema: describeInput, annotations,
}, ({ operation }) => gatewayRead(async () => {
  if (getOperation(operation).kind !== 'read') {
    throw new ClientError('unavailable', 'The stdio server supports read operations only.');
  }
  return describeOperation(operation);
}));

server.registerTool('read', {
  description: 'Run a named Authorize.net read. Discover the operation input with describe_operation.',
  inputSchema: dispatchInput, annotations,
}, (input, { signal }) => gatewayRead(async () => {
  const { operation, args } = parseDispatchInput(input, 'read');
  const result = await merchantClient(signal).execute(getOperation(operation), args);
  return { environment, operation, result };
}));

server.registerTool('get_subscription_schedules', {
  description: 'Get provider amounts and billing cadences for up to 20 distinct ARB subscription IDs. Returns per-ID outcomes.',
  inputSchema: scheduleInput, annotations,
}, (input, { signal }) => gatewayRead(async () => {
  const client = merchantClient(signal);
  const operation = getOperation('get_subscription');
  const batch = await readSubscriptionSchedules(input, (subscriptionId) =>
    client.execute(operation, { subscriptionId, includeTransactions: false }),
  );
  return { environment, ...batch };
}));

await server.connect(new StdioServerTransport());
