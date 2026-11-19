# Coverage and verification

The gateway baseline is the 53 top-level request elements from Authorize.net's official XSD, retrieved November 19, 2026. The Webhooks baseline is nine distinct method and path pairs in the official guide. The pinned machine-readable baseline is [provider-inventory.json](../test/fixtures/provider-inventory.json). The tests compare it against the compiled catalog and webhook request builders. [Gateway schema](https://api.authorize.net/xml/v1/schema/AnetApiSchema.xsd) · [API reference](https://developer.authorize.net/api/reference/index.html) · [Webhooks guide](https://developer.authorize.net/api/reference/features/webhooks.html)

| Family | Implemented use | Known limits |
| --- | --- | --- |
| Gateway authentication and merchant capabilities | Key check and sanitized merchant details | Partner OAuth, reseller onboarding, mobile device credentials and merchant mode changes require separate contracts. |
| Transactions and fraud | Saved-profile authorization and charge, prior capture, refund, void, supported PayPal references, split tender, fraud decisions | Fresh instruments, Apple Pay and Google Pay wallets, eCheck collection, external capture and PayPal starts need protected interactive flows. Refund balance across historical adjustments and split-tender group readback are limited by provider evidence. |
| Recurring billing | Create from a saved profile, read, status, list, update supported fields and cancel | Payment schedule edits need reliable installment and eligibility evidence. ARB creation confirms a schedule, with payment tracked separately. |
| Customer profiles | Customer create, read, update and delete, import from a transaction, saved payment reads and validation, shipping address CRUD | New and replacement instruments require a protected collection path. Address and instrument data are redacted from MCP reads. |
| Reporting and Account Updater | Exact transaction and batch lookup, bounded lists, UTC settlement windows and updater jobs | Merchant features must be enabled. Gateway settlement evidence does not prove a bank deposit. |
| Webhooks | Event discovery, endpoint reads and writes, inactive endpoint ping, notification history | Uses existing merchant receiver endpoints. Inbound notification processing needs its own receiver and Signature Key. |
| Hosted forms | Catalog inventory and [handoff requirements](hosted.md) | Browser handoff currently unavailable in the native runtime. |

Catalog availability denotes a mounted adapter. It is independent of a given merchant's enabled features and live evidence. A provider request may have multiple catalog entries with distinct effects. Legacy and device-specific entries remain visible with their prerequisites.

## Release verification

Local checks cover HTTP request envelopes, Basic auth, output projection, pagination, environment binding, business errors, and SQL receipts with fixtures. Standard MCP clients exercise tool discovery, reads and writes against a mock gateway over stdio and Streamable HTTP.

Live checks covered merchant authentication, settlement and ARB reads, Webhooks REST, and a sandbox customer profile's approval, creation, readback, deletion and not-found verification. Charge and refund execution, hosted forms and independent workspace isolation still need live verification. Keep merchant keys in the connection form and exact merchant test data out of the public repo.

Executor enables writes only in Sandbox. The standalone server also supports production writes, with permissions managed by the MCP client.
