import { RiviumFlags } from '@rivium/flags-node';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rivium Flags — Node.js SDK example (0.2.0)
//   RIVIUM_API_KEY=rv_live_… RIVIUM_FLAGS_SERVER_SECRET=rv_srv_… npm start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const API_KEY = process.env.RIVIUM_API_KEY || 'YOUR_API_KEY';
const SERVER_SECRET = process.env.RIVIUM_FLAGS_SERVER_SECRET || 'YOUR_SERVER_SECRET';
const ENVIRONMENT = process.env.RIVIUM_FLAGS_ENVIRONMENT || undefined;

async function main() {
  const flags = new RiviumFlags({
    apiKey: API_KEY,
    serverSecret: SERVER_SECRET,
    environment: ENVIRONMENT,
    sendUsage: true,
    debug: true,
  });

  flags.on('ready', ({ flagCount }) => console.log(`ready: ${flagCount} flags`));
  flags.on('update', ({ flagCount }) => console.log(`rules updated: ${flagCount} flags`));
  flags.on('error', (e) => console.log(`error: ${e.message}`));

  await flags.init();
  console.log(`isReady = ${flags.isReady()}`);

  const keys = flags.getFlagKeys();
  console.log(`flags: ${keys.join(', ') || '(none)'}`);

  // Every evaluation is local: pass the context per call.
  const users = [
    { userId: 'user-1', attributes: { plan: 'pro', country: 'AM' } },
    { userId: 'user-2', attributes: { plan: 'free', country: 'US' } },
    { anonymousId: '3f1c2b8e-9d0a-4c51-a1f2-6f0b7e2d9c11' },
  ];

  for (const ctx of users) {
    console.log(`\ncontext ${JSON.stringify(ctx)}`);
    for (const [key, d] of Object.entries(flags.getAll(ctx))) {
      console.log(`  ${key}: enabled=${d.enabled} value=${JSON.stringify(d.value)} variant=${d.variant} reason=${d.reason}`);
    }
  }

  // Typed getters return your default with a reason when the flag is missing or of another type.
  const missing = flags.getDetail('nonexistent_flag', { userId: 'user-1' }, 'fallback');
  console.log(`\nnonexistent_flag → value=${missing.value} reason=${missing.reason}`);

  await flags.refresh();
  await flags.close(); // stops polling and flushes usage counts
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
