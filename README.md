# Authorize.net MCP

Authorize.net merchant operations for MCP clients. Use your own API Login ID and Transaction Key to inspect payments and settlement, manage sandbox transactions and subscriptions, and work with customer profiles and webhooks.

The current runtime target is Executor. The app runs natively in the workspace and uses its existing MCP connection. There is no separate service or OAuth setup.

## Connect a merchant

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
| `read` | `{"operation":"get_transaction","args":{"transId":"12345"}}` | Runs a read against the caller's linked merchant and environment. |
| `get_subscription_schedules` | `{"subscriptionIds":["12345","67890"]}` | Reads provider amounts and billing intervals for up to 20 exact ARB IDs. Reports errors per ID and omits customer profiles. |
| `write` | `{"operation":"cancel_subscription","args":{"subscriptionId":"67890"}}` | Requests human approval for a Sandbox write. |

A Transaction Key can authorize financial operations at Authorize.net. Executor restricts where its handles can be sent. The app's static operation catalog and approval policy restrict what gets sent. Production connections currently support reads. The production write gate stays closed until the native approval and connection binding can be verified on the deployed runtime.

To audit recurring revenue, list subscriptions in ascending ID order and follow `result.coverage.nextOffset`. Authorize.net can report zero in `totalNumInResultSet` on later pages that still contain subscriptions. Use the first page's `coverage.totalMatching` and verify the number of distinct IDs across the pages. A short page can end the scan even when the provider total is unknown. The page metadata explains whether the next offset came from the provider total or the page size.

Use `get_subscription_schedules` for exact cadence, with smaller batches for spot checks. Every ID costs one Authorize.net read. Use `complete` and the per-ID outcomes to detect partial results. The gateway list can supply currency. An exact schedule read may omit it. Gateway failures include the sanitized provider code when Authorize.net supplies one.

Each installation has one caller-owned merchant connection. Use separate installations to keep Sandbox and Production linked at the same time. An existing compatible Executor account can be linked directly. Credentials held by a different service need an authorized handoff into Executor account setup. Account setup and a successful gateway read are separate checks.

## Coverage

The catalog accounts for 53 gateway request envelopes and every documented Webhooks REST route. It has 24 read and 30 write implementations, with 31 additional entries that explain unmet browser, account, or provider prerequisites. Multiple payment variants share a gateway request envelope.

Available writes cover saved-profile payments, capture, void and refund, fraud decisions, supported PayPal continuations, ARB, CIM metadata and webhook management. Each is subject to merchant capability and sandbox approval. Fresh card or bank data, wallet payloads and form tokens belong in a protected payment flow. See [hosted payment handoffs](docs/hosted.md) and [coverage and verification](docs/coverage.md).

For a write, the app stores a receipt fingerprint before dispatch. Equivalent normalized input for the same linked account returns the receipt. It does not dispatch a second write. If completion is unknown, inspect the provider using the exact object references before attempting another operation. Never change the arguments just to work around the receipt.

## Work on the app

Requires Node.js 24. The runtime SDK and direct dependencies are pinned in `package.json`.

```sh
npm install --no-package-lock
npm run typecheck
npm test
```

The tests use fake provider responses and an isolated SQLite fixture. None require credentials or contact Authorize.net. To deploy into a private workspace, use Executor's app-authoring guide to create an app ID, then deploy from the repository root using the signed-in CLI.

```sh
executor apps deploy --app <app-id> --files .
```

Verify the Sandbox connection and representative operations before publishing the same source through the community registry. Keep the Git commit and Executor deployment ID in the release record. [Executor documentation](https://executor.sh/docs)

## License

[MIT](LICENSE)
