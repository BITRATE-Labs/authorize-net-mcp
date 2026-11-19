import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const entry = fileURLToPath(new URL('../src/stdio.ts', import.meta.url));
const fixture = new URL('./fixtures/stdio-provider.mjs', import.meta.url).href;
const cwd = fileURLToPath(new URL('..', import.meta.url));
const args = ['--import', 'tsx', '--import', fixture, entry];
const env = {
  AUTHORIZE_NET_API_LOGIN_ID: 'fixture-login',
  AUTHORIZE_NET_TRANSACTION_KEY: 'fixture-key',
};
const deletion = { operation: 'delete_customer_profile', args: { customerProfileId: '1' } };

test('standard MCP stdio client discovers and calls production reads and writes', async (context) => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd,
    env: {
      AUTHORIZE_NET_ENVIRONMENT: 'production',
      ...env,
    },
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(),
      ['describe_operation', 'get_subscription_schedules', 'list_operations', 'read', 'write']);
    assert.equal(tools.find((tool) => tool.name === 'read')?.annotations?.readOnlyHint, true);
    assert.deepEqual(tools.find((tool) => tool.name === 'write')?.annotations, {
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    });
    const catalog = await client.callTool({ name: 'list_operations', arguments: {} });
    const rows = (catalog.structuredContent as { operations: { kind: string }[] }).operations;
    assert.ok(rows.some((row) => row.kind === 'read'));
    assert.ok(rows.some((row) => row.kind === 'write'));
    const read = await client.callTool({ name: 'read', arguments: {
      operation: 'get_transaction', args: { transId: '12' },
    } });
    assert.deepEqual(read.structuredContent, {
      environment: 'production', operation: 'get_transaction',
      result: { transaction: { transId: '12', transactionStatus: 'settledSuccessfully', settleAmount: '5.99' },
        currency: { code: null, source: 'Not supplied by this reporting response' },
        coverage: 'Exact transaction; does not establish every linked refund or remaining refundable balance' },
    });
    const schedule = await client.callTool({ name: 'get_subscription_schedules', arguments: { subscriptionIds: ['1', '2'] } });
    const output = schedule.structuredContent as { complete: boolean; results: { ok: boolean; error?: { providerCode: string } }[] };
    assert.equal(output.complete, false);
    assert.equal(output.results[0].ok, true);
    assert.equal(output.results[1].error?.providerCode, 'E00035');
    assert.doesNotMatch(JSON.stringify(schedule), /hidden provider/);
    const wrongKind = await client.callTool({ name: 'read', arguments: deletion });
    assert.equal(wrongKind.isError, true);
    const write = await client.callTool({ name: 'write', arguments: deletion });
    assert.equal(write.isError ?? false, false, JSON.stringify(write.structuredContent));
    assert.partialDeepStrictEqual(write.structuredContent, { environment: 'production', operation: deletion.operation });
  } catch (error) {
    if (diagnostics) context.diagnostic(diagnostics);
    throw error;
  } finally {
    await client.close();
  }
});

test('Streamable HTTP exposes sandbox reads and writes over loopback', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [...args, '--http', '0'], {
    cwd, env: { ...process.env, ...env, AUTHORIZE_NET_ENVIRONMENT: 'sandbox' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const lines = createInterface({ input: child.stderr });
  const client = new Client({ name: 'http-smoke', version: '1.0.0' });
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    assert.match(line, /^MCP listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const url = new URL(line.slice('MCP listening on '.length));
    const rejected = await fetch(url, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(rejected.status, 403);
    await rejected.body?.cancel();
    await client.connect(new StreamableHTTPClientTransport(url));
    const read = await client.callTool({ name: 'read', arguments: {
      operation: 'get_transaction', args: { transId: '12' },
    } });
    assert.partialDeepStrictEqual(read.structuredContent, { environment: 'sandbox' });
    const write = await client.callTool({ name: 'write', arguments: deletion });
    assert.equal(write.isError ?? false, false, JSON.stringify(write.structuredContent));
    assert.partialDeepStrictEqual(write.structuredContent, { environment: 'sandbox', operation: deletion.operation });
  } finally {
    await client.close();
    lines.close();
    child.kill();
  }
});
