import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standard MCP stdio client discovers and calls read-only merchant tools', async (context) => {
  const entry = fileURLToPath(new URL('../src/stdio.ts', import.meta.url));
  const fixture = new URL('./fixtures/stdio-provider.mjs', import.meta.url).href;
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', fixture, entry],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      AUTHORIZE_NET_ENVIRONMENT: 'production',
      AUTHORIZE_NET_API_LOGIN_ID: 'fixture-login',
      AUTHORIZE_NET_TRANSACTION_KEY: 'fixture-key',
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
      ['describe_operation', 'get_subscription_schedules', 'list_operations', 'read']);
    const catalog = await client.callTool({ name: 'list_operations', arguments: {} });
    const rows = (catalog.structuredContent as { operations: { kind: string }[] }).operations;
    assert.ok(rows.length > 0 && rows.every((row) => row.kind === 'read'));
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
    const write = await client.callTool({ name: 'read', arguments: {
      operation: 'delete_customer_profile', args: { customerProfileId: '1' },
    } });
    assert.equal(write.isError, true);
  } catch (error) {
    if (diagnostics) context.diagnostic(diagnostics);
    throw error;
  } finally {
    await client.close();
  }
});
