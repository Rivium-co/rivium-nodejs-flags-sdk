<p align="center">
  <a href="https://rivium.co">
    <img src="https://rivium.co/logo.png" alt="Rivium" width="120" />
  </a>
</p>

<h3 align="center">Rivium Flags Node.js SDK</h3>

<p align="center">
  Server-side feature flag management for Node.js with targeting rules and rollout control.
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

## Quick Start

```typescript
import { RiviumFlags } from '@rivium/flags-node';

const flags = new RiviumFlags({
  apiKey: 'YOUR_API_KEY',
  serverSecret: 'YOUR_SERVER_SECRET',
  environment: 'production',
});

await flags.init();

// Check if a flag is enabled
const darkMode = flags.isEnabled('dark_mode', { userId: 'user-123' });

// Get flag value
const variant = flags.getValue('checkout_flow', { userId: 'user-123' });

// Full evaluation with targeting
const result = flags.evaluate('premium_banner', {
  userId: 'user-123',
  userAttributes: { plan: 'pro', country: 'US' },
});
console.log(result.enabled, result.value, result.variant);

// Refresh flags from server
await flags.refresh();
```

## Features

- **Server-Side Evaluation** — Secure evaluation with `apiKey` + `serverSecret` (secrets never exposed to client)
- **Per-Request Context** — Pass `userId` and `userAttributes` per call with no shared state
- **Boolean & Multivariate Flags** — Simple on/off toggles or multi-variant flags with weighted distribution
- **Targeting Rules** — Target users by attributes (equals, contains, regex, in, greater_than, and more)
- **Rollout Percentages** — Gradual rollouts with deterministic MD5-based bucketing
- **Environment Overrides** — Separate flag values per environment (development, staging, production)
- **TypeScript** — Full type safety with exported types and declarations

## Documentation

For full documentation, visit [rivium.co/docs](https://rivium.co/docs).

## License

MIT License — see [LICENSE](LICENSE) for details.
