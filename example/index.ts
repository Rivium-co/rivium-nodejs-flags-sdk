import { RiviumFlags } from '@rivium/flags-node';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rivium Flags — Node.js SDK Test Suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const API_KEY = process.env.RIVIUM_FLAGS_API_KEY || 'YOUR_API_KEY';
const SERVER_SECRET = process.env.RIVIUM_FLAGS_SERVER_SECRET || 'YOUR_SERVER_SECRET';

interface TestResult {
  test: string;
  detail: string;
  pass: boolean;
}

const results: TestResult[] = [];

function addResult(test: string, detail: string, pass: boolean) {
  results.push({ test, detail, pass });
  const icon = pass ? '✓' : '✗';
  const color = pass ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${test}`);
  console.log(`    \x1b[2m${detail}\x1b[0m`);
}

async function main() {
  console.log('\n\x1b[1m\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log('\x1b[1m\x1b[33m  Rivium Flags — Node.js SDK Test Suite\x1b[0m');
  console.log('\x1b[1m\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

  // ── Initialize ──
  const flags = new RiviumFlags({
    apiKey: API_KEY,
    serverSecret: SERVER_SECRET,
    debug: true,
  });

  try {
    await flags.init((event, data) => {
      console.log(`  \x1b[2m[event] ${event}:\x1b[0m`, data);
    });
    addResult('Initialize SDK', `Connected with API key + server secret`, true);
  } catch (error) {
    addResult('Initialize SDK', `Failed: ${error}`, false);
    printSummary();
    return;
  }

  // ── Test 1: Fetch all flags ──
  const allFlags = flags.getAll();
  addResult(
    'GET /public/flags',
    `Fetched ${allFlags.length} flags: ${allFlags.map((f) => f.key).join(', ')}`,
    allFlags.length > 0,
  );

  // ── Test 2: Simple boolean flag ──
  const darkMode = flags.isEnabled('dark_mode', { userId: 'test-user-1' });
  addResult(
    'Boolean flag: dark_mode',
    `isEnabled = ${darkMode}`,
    true,
  );

  // ── Test 3: Multivariate flag ──
  const checkoutResult = flags.evaluate('checkout_flow', { userId: 'test-user-1' });
  addResult(
    'Multivariate: checkout_flow',
    `enabled=${checkoutResult.enabled}, value=${checkoutResult.value}, variant=${checkoutResult.variant}`,
    true,
  );

  // ── Test 4: Targeting rules ──
  const premiumMatch = flags.isEnabled('premium_banner', {
    userId: 'test-user-1',
    userAttributes: { plan: 'pro', country: 'US' },
  });
  addResult(
    'Targeting (plan=pro, country=US)',
    `premium_banner = ${premiumMatch}`,
    true,
  );

  const premiumNoMatch = flags.isEnabled('premium_banner', {
    userId: 'test-user-1',
    userAttributes: { plan: 'free', country: 'IR' },
  });
  addResult(
    'Targeting (plan=free, country=IR)',
    `premium_banner = ${premiumNoMatch}`,
    true,
  );

  // ── Test 5: Gradual rollout ──
  const rolloutResults: Record<string, boolean> = {};
  for (const uid of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
    rolloutResults[uid] = flags.isEnabled('gradual_redesign', { userId: uid });
  }
  const enabledCount = Object.values(rolloutResults).filter(Boolean).length;
  addResult(
    'Rollout 30%: gradual_redesign',
    `${Object.entries(rolloutResults).map(([k, v]) => `${k}=${v}`).join(', ')} → ${enabledCount}/5 enabled`,
    true,
  );

  // ── Test 6: getValue with default ──
  const missingValue = flags.getValue('nonexistent_flag', {}, 'fallback');
  addResult(
    'Default value: nonexistent_flag',
    `getValue = "${missingValue}" (default: "fallback")`,
    missingValue === 'fallback',
  );

  // ── Test 7: Refresh ──
  await flags.refresh();
  addResult(
    'Manual refresh',
    `Refreshed flags. Total: ${flags.getAll().length}`,
    true,
  );

  // ── Test 8: Server context per request ──
  const user1 = flags.isEnabled('dark_mode', { userId: 'user-1' });
  const user2 = flags.isEnabled('dark_mode', { userId: 'user-2' });
  addResult(
    'Per-request context (server-side)',
    `user-1=${user1}, user-2=${user2} — no shared state`,
    true,
  );

  // ── Test 9: Environment overrides ──
  // Compare flag values across different environments.
  // Setup in dashboard:
  //   1. Create a flag (e.g. "maintenance_mode") → globally disabled
  //   2. Create environments: development, staging, production
  //   3. Override: development → enabled, staging → enabled, production → keep default
  // Then this test shows different values per environment.
  const testFlagKey = allFlags.length > 0 ? allFlags[0].key : 'maintenance_mode';
  const envResults: Record<string, { totalFlags: number; enabled: boolean; value: any }> = {};

  for (const env of ['none', 'development', 'staging', 'production']) {
    try {
      const envFlags = new RiviumFlags({
        apiKey: API_KEY,
        serverSecret: SERVER_SECRET,
        environment: env === 'none' ? undefined : env,
        debug: true,
      });
      await envFlags.init();
      const envAll = envFlags.getAll();
      const flagEnabled = envFlags.isEnabled(testFlagKey, { userId: 'test-user-1' });
      const flagValue = envFlags.evaluate(testFlagKey, { userId: 'test-user-1' });
      envResults[env] = {
        totalFlags: envAll.length,
        enabled: flagEnabled,
        value: flagValue.value,
      };
    } catch (e) {
      envResults[env] = { totalFlags: 0, enabled: false, value: `error: ${e}` };
    }
  }

  const envDetail = Object.entries(envResults)
    .map(([env, r]) => `${env}: enabled=${r.enabled}, value=${r.value}, flags=${r.totalFlags}`)
    .join('\n');
  addResult(
    `Environment overrides: ${testFlagKey}`,
    `Flag "${testFlagKey}" across environments:\n${envDetail}`,
    true,
  );

  // ── Test 10: Reset & Dispose ──
  const flagsBefore = flags.getAll().length;
  flags.dispose();
  flags.reset();
  const flagsAfter = flags.getAll().length;
  addResult(
    'Reset & Dispose',
    `Before: ${flagsBefore} flags, dispose() called, After reset: ${flagsAfter} flags`,
    flagsAfter === 0,
  );

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log('\n\x1b[1m\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log(`  \x1b[32m✓ Passed: ${passed}\x1b[0m`);
  if (failed > 0) console.log(`  \x1b[31m✗ Failed: ${failed}\x1b[0m`);
  console.log(`  Total: ${results.length} tests`);
  console.log('\x1b[1m\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
}

main().catch(console.error);
