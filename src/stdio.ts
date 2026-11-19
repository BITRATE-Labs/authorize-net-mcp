import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describeOperation, getOperation, listOperations } from './catalog.js';
import { ClientError, createClient } from './client.js';
import { describeInput, dispatchInput, listInput, parseDispatchInput, parseWebhookOrigin, readSubscriptionSchedules, scheduleInput } from './tools.js';

const configuredEnvironment = process.env.AUTHORIZE_NET_ENVIRONMENT ?? 'sandbox';
if (configuredEnvironment !== 'sandbox' && configuredEnvironment !== 'production') {
  console.error('AUTHORIZE_NET_ENVIRONMENT must be sandbox or production.');
  process.exit(1);
}
const environment = configuredEnvironment;

const readAnnotations = { readOnlyHint: true, openWorldHint: true };
const discoveryAnnotations = { readOnlyHint: true, openWorldHint: false };

function response(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

async function toolResult(run: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
  try {
    return response(await run());
  } catch (error) {
    const detail = error instanceof ClientError
      ? { code: error.code, message: error.message, ...(error.providerCode ? { providerCode: error.providerCode } : {}) }
      : { code: 'invalid_input', message: 'Check the operation and its input schema.' };
    return { ...response({ environment, error: detail }), isError: true };
  }
}

function merchantClient(signal: AbortSignal, allowWrites = false) {
  const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY;
  if (!apiLoginId || !transactionKey) {
    throw new ClientError('credentials_rejected', 'Set AUTHORIZE_NET_API_LOGIN_ID and AUTHORIZE_NET_TRANSACTION_KEY to run merchant operations.');
  }
  const webhookOrigin = allowWrites ? parseWebhookOrigin(process.env.AUTHORIZE_NET_WEBHOOK_DESTINATION_ORIGIN) : undefined;
  return createClient({ environment, apiLoginId, transactionKey, fetch: globalThis.fetch, signal, allowWrites, webhookOrigin });
}

function createServer() {
  const server = new McpServer({ name: 'authorize-net-mcp', version: '0.4.0' });

  server.registerTool('list_operations', {
    description: 'List Authorize.net operations and their availability.',
    inputSchema: listInput, annotations: discoveryAnnotations,
  }, () => response({ environment, operations: listOperations() }));

  server.registerTool('describe_operation', {
    description: 'Get the exact input schema or prerequisites for an Authorize.net operation.',
    inputSchema: describeInput, annotations: discoveryAnnotations,
  }, ({ operation }) => toolResult(() => describeOperation(operation)));

  for (const kind of ['read', 'write'] as const) {
    server.registerTool(kind, {
      description: `Run a named Authorize.net ${kind} in ${environment}. Discover its input with describe_operation.`,
      inputSchema: dispatchInput,
      annotations: kind === 'read' ? readAnnotations : {
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
      },
    }, (input, { signal }) => toolResult(async () => {
      const { operation, args } = parseDispatchInput(input, kind);
      const result = await merchantClient(signal, kind === 'write').execute(getOperation(operation), args);
      return { environment, operation, result };
    }));
  }

  server.registerTool('get_subscription_schedules', {
    description: 'Get provider amounts and billing cadences for up to 20 distinct ARB subscription IDs. Returns per-ID outcomes.',
    inputSchema: scheduleInput, annotations: readAnnotations,
  }, (input, { signal }) => toolResult(async () => {
    const client = merchantClient(signal);
    const operation = getOperation('get_subscription');
    const batch = await readSubscriptionSchedules(input, (subscriptionId) =>
      client.execute(operation, { subscriptionId, includeTransactions: false }),
    );
    return { environment, ...batch };
  }));
  return server;
}

const [transportName, portArgument = '3000', ...extra] = process.argv.slice(2);
if (transportName === undefined) {
  await createServer().connect(new StdioServerTransport());
} else {
  const port = Number(portArgument);
  if (transportName !== '--http' || !/^\d+$/.test(portArgument) || port > 65535 || extra.length > 0) {
    console.error('Usage: node dist/stdio.js [--http [port]]');
    process.exit(1);
  }
  const host = '127.0.0.1';
  const app = createMcpExpressApp({ host });
  app.all('/mcp', async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}:${req.socket.localPort}`
      && origin !== `http://localhost:${req.socket.localPort}`) {
      res.writeHead(403).end();
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const listener = app.listen(port, host, () => {
    const address = listener.address();
    if (address && typeof address === 'object') console.error(`MCP listening on http://${host}:${address.port}/mcp`);
  });
}
