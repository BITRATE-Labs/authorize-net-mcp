# Authorize.net MCP

Work with Authorize.net transactions, settlement batches, recurring agreements, customer profiles, and webhooks from an MCP client. Use your own merchant API Login ID and Transaction Key.

| Runtime | Supported operations |
| --- | --- |
| Local MCP server over stdio or Streamable HTTP | Sandbox and production reads and writes, with permissions managed by your MCP client |
| Executor community app | Sandbox and production reads, plus sandbox writes with human approval |

## Start a local MCP server

Install Node.js 24, then build the server.

```sh
git clone https://github.com/BITRATE-Labs/authorize-net-mcp.git
cd authorize-net-mcp
npm install --no-package-lock
npm run build:stdio
```

Supply credentials through your client or process environment. `AUTHORIZE_NET_ENVIRONMENT` defaults to `sandbox`. Set it to `production` to work with your live merchant.

| Environment variable | Value |
| --- | --- |
| `AUTHORIZE_NET_API_LOGIN_ID` | Your merchant API Login ID |
| `AUTHORIZE_NET_TRANSACTION_KEY` | Your merchant Transaction Key |
| `AUTHORIZE_NET_ENVIRONMENT` | `sandbox` or `production` |
| `AUTHORIZE_NET_WEBHOOK_DESTINATION_ORIGIN` | Optional merchant-controlled HTTPS origin for webhook changes |

- **stdio.** Configure your client to launch `node` with the absolute path to `dist/stdio.js` as its argument.
- **Streamable HTTP.** Run `node dist/stdio.js --http` and point your client at `http://127.0.0.1:3000/mcp`. Pass a port after `--http` to change it. Local processes can call this endpoint using the merchant credentials supplied to the server.

Tool discovery works before credentials are configured. To verify a connection, call `read` with `{"operation":"authenticate_test","args":{}}`. The standalone `write` tool advertises `destructiveHint: true` and `idempotentHint: false` so your client can apply its permission policy. Restrict access to `write` in your client for a read-only workflow.

## Install in Executor

1. Install the community package `@basicbit.executor.community/authorize-net-mcp` in your Executor workspace. Review the listed source revision before copying it. [Executor public apps](https://executor.sh/docs/concepts/apps-and-deployments#public-apps)
2. Link your own merchant connection and select **Sandbox** or **Production**. Enter both values in the Executor browser form. [Authorize.net credential setup](https://developer.authorize.net/hello_world/common_setup_questions.html)
3. To test webhook changes, optionally enter a merchant-controlled HTTPS destination origin such as `https://hooks.example.com`. The app checks the exact origin and the current webhook destination before sending a change.
4. Run `list_operations` and then `describe_operation` before dispatching an operation. Executor requires the merchant link before exposing the app tools.

Use an Authorize.net sandbox merchant in Live Mode to persist test transactions. The Sandbox connection is fixed to the sandbox host independently of the merchant's Test Mode setting. [Authorize.net testing guide](https://developer.authorize.net/hello_world/testing_guide.html)

To install from the signed-in Executor CLI, find the package in `executor apps catalog` and use the full commit shown for it.

```sh
executor apps install --package @basicbit.executor.community/authorize-net-mcp --commit <catalog-commit> --name "Authorize.net MCP"
```

## Tool calls

| Tool | Input | Purpose |
| --- | --- | --- |
| `list_operations` | `{}` | Lists operation IDs, wire requests, effects and implementation availability. |
| `describe_operation` | `{"operation":"get_transaction"}` | Returns the exact input schema or the reason an operation needs another integration. |
| `read` | `{"operation":"get_transaction","args":{"transId":"12345"}}` | Runs a read against the configured merchant and environment. |
| `get_subscription_schedules` | `{"subscriptionIds":["12345","67890"]}` | Reads provider amounts and billing intervals for up to 20 exact ARB IDs. Reports errors per ID and omits customer profiles. |
| `write` | `{"operation":"cancel_subscription","args":{"subscriptionId":"67890"}}` | Runs a write in the configured environment. Executor requires human approval and limits writes to Sandbox. |

A Transaction Key can authorize financial operations at Authorize.net. The operation catalog and runtime enforce read and write limits. Keep keys scoped to the intended merchant and environment. [Authorize.net credential setup](https://developer.authorize.net/hello_world/common_setup_questions.html)

To audit recurring revenue, list subscriptions in ascending ID order and follow `result.coverage.nextOffset`. Authorize.net can report zero in `totalNumInResultSet` on later pages that still contain subscriptions. Use the first page's `coverage.totalMatching` and verify the number of distinct IDs across the pages. A short page can end the scan even when the provider total is unknown. The page metadata explains whether the next offset came from the provider total or the page size.

Use `get_subscription_schedules` for exact cadence, with smaller batches for spot checks. Every ID costs one Authorize.net read. Use `complete` and the per-ID outcomes to detect partial results. The gateway list can supply currency. An exact schedule read may omit it. Gateway failures include the sanitized provider code when Authorize.net supplies one.

Each client configuration or Executor installation uses one merchant connection. Use separate configurations to keep Sandbox and Production available at the same time.

## Coverage

The catalog accounts for 53 gateway request envelopes and every documented Webhooks REST route. It has 24 read and 30 write implementations, with 31 additional entries that explain unmet browser, account, or provider prerequisites. Multiple payment variants share a gateway request envelope.

Write operations cover saved-profile payments, capture, void and refund, fraud decisions, supported PayPal continuations, ARB, CIM metadata and webhook management. Availability depends on merchant capabilities. Fresh card or bank data, wallet payloads and form tokens belong in a protected payment flow. See [hosted payment handoffs](docs/hosted.md) and [coverage and verification](docs/coverage.md).

Executor stores a receipt fingerprint before dispatch. Equivalent normalized input for the same linked account returns the receipt. If a write returns `completion_unknown`, inspect the provider using the exact object references before resubmitting.

## Development

Requires Node.js 24. The runtime SDK and direct dependencies are pinned in `package.json`.

```sh
npm install --no-package-lock
npm run typecheck
npm run build:stdio
npm test
```

The tests use fake provider responses and an isolated SQLite fixture. The MCP smoke tests discover tools and run reads and writes against a mock gateway over stdio and Streamable HTTP. To deploy the Executor app into a private workspace, use the app-authoring guide to create an app ID, then deploy from the repository root using the signed-in CLI.

```sh
executor apps deploy --app <app-id> --files .
```

Verify the Sandbox connection and representative operations before publishing the same source through the community registry. Keep the Git commit and Executor deployment ID in the release record. [Executor documentation](https://executor.sh/docs)

## License

[MIT](LICENSE)
