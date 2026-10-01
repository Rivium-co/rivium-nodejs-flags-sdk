<p align="center">
  <a href="https://rivium.co">
    <img src="https://rivium.co/logo.png" alt="Rivium" width="120" />
  </a>
</p>

<h3 align="center">Rivium Flags Node.js SDK</h3>

<p align="center">
  Server-side feature flags for Node.js: rules are downloaded once and kept fresh, every evaluation runs locally.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rivium/flags-node"><img src="https://img.shields.io/npm/v/@rivium/flags-node.svg" alt="npm" /></a>
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5+" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
</p>

---

## Installation

```bash
npm install @rivium/flags-node
```

Node.js 18 or newer (uses the built-in `fetch`).

## Quick start

```typescript
import { RiviumFlags } from '@rivium/flags-node';

const flags = new RiviumFlags({
  apiKey: process.env.RIVIUM_API_KEY!,                    // rv_live_… / rv_test_…
  serverSecret: process.env.RIVIUM_FLAGS_SERVER_SECRET!,  // rv_srv_… — backend only
  environment: 'production',                              // omit for the Default layer
});

await flags.init(); // resolves after the first fetch (or after 5 s); never rejects

const user = { userId: 'user-123', attributes: { plan: 'pro', country: 'AM' } };

if (flags.isEnabled('new-checkout', user)) {
  // …
}
const theme = flags.getString('theme', user, 'light');
const limit = flags.getNumber('upload-limit-mb', user, 10);
const banner = flags.getJson('banner', user, { text: '' });

// on shutdown
await flags.close();
```

## Context

There is no shared user state: pass the context with every call.

```typescript
interface EvaluationContext {
  userId?: string | null;       // signed-in user's stable id
  anonymousId?: string | null;  // e.g. the id your web / mobile client sends
  attributes?: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
}
```

Rollouts and variant splits bucket by `userId`, or by `anonymousId` when there is no user id. Without either, a
partial rollout or a split is served off with reason `NO_BUCKETING_ID`. Rules on `userId` / `anonymousId` read the
context fields, never attributes of the same name.

## Getters

| Method | Returns |
|---|---|
| `isEnabled(key, context?, defaultValue = false)` | `true` only when the flag is served on (reason `ON` or `VARIANT`) |
| `getBoolean(key, context, defaultValue)` | the flag's value, or the default |
| `getString(key, context, defaultValue)` | " |
| `getNumber(key, context, defaultValue)` | " |
| `getJson<T>(key, context, defaultValue)` | " |
| `getDetail(key, context, defaultValue, valueType?)` | `{ key, value, enabled, variant, reason, version, valueType }` |
| `getAll(context?)` | every flag evaluated for the context, by key |
| `getFlagKeys()` | the keys of the loaded flags |

Typed getters return your default when the flag does not exist (`FLAG_NOT_FOUND`), rules are not loaded yet
(`NOT_READY`) or the flag has another value type (`TYPE_MISMATCH`). Other reasons: `ON`, `VARIANT`, `DISABLED`,
`PREREQUISITE_FAILED`, `NOT_TARGETED`, `OUTSIDE_ROLLOUT`, `NO_BUCKETING_ID`, `ERROR`.

```typescript
const d = flags.getDetail('theme', user, 'light', 'string');
console.log(d.value, d.variant, d.reason); // "dark" "dark" "VARIANT"
```

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | — | project key, required |
| `serverSecret` | — | server secret, required |
| `environment` | Default layer | environment key |
| `pollIntervalSeconds` | `30` | minimum 10; `0` turns polling off |
| `initTimeoutMs` | `5000` | how long `init()` waits for the first fetch |
| `sendUsage` | `false` | send aggregated evaluation counts to the dashboard (not billed, no user ids) |
| `debug` | `false` | debug logs |
| `logger` | console | `{ debug, info, warn, error }` |
| `baseUrl` | `https://flags.rivium.co` | |

## Lifecycle and events

- `init()` — first fetch, then ETag polling. Rules stay in memory; a failed poll keeps the last good rules.
- `refresh()` — fetch now. Also restarts polling after a 401 / 403 / 404 stopped it.
- `close()` — stop polling and flush usage counts.
- `on('ready' | 'update' | 'error', listener)` — returns an unsubscribe function.

Rate limits (429) and server errors back off (honouring `Retry-After`, ×2 up to 5 minutes). Fetching rules and local
evaluations are not billed.

## Server vs client

This is the **server** SDK. The server secret can read every rule of your project: keep it on your backend, never in a
browser or an app bundle (the SDK refuses to start in a browser). Browsers and apps use the client SDKs (Next.js
client, iOS, Android, Flutter, React Native) with the public key; they ask the server for results and never see rules.

## Migrating from 0.1.x

| 0.1.x | 0.2.0 |
|---|---|
| `isEnabled(key, { userId, userAttributes })` | `isEnabled(key, { userId, attributes })` |
| `getValue(key, ctx, default)` | `getBoolean` / `getString` / `getNumber` / `getJson(key, ctx, default)` |
| `evaluate(key, ctx)` | `getDetail(key, ctx, default)` (now with `reason` and `version`) |
| `getAll()` (raw flags) | `getAll(ctx)` (evaluated results) / `getFlagKeys()` |
| `init(callback)` | `init()` + `on('ready' / 'update' / 'error', …)` |
| `dispose()` / `reset()` | `close()` |
| MD5 bucketing | SHA-256 per flag and salt — users are re-bucketed once |

Rules are now loaded from `GET /server/v2/flags` and kept fresh automatically, so you no longer need to call
`refresh()` on a timer.

## Documentation

For full documentation, visit [rivium.co/docs](https://rivium.co/docs).

## License

MIT License — see [LICENSE](LICENSE) for details.
