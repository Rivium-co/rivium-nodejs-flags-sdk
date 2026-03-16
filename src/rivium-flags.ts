import * as crypto from 'crypto';
import {
  RiviumFlagsConfig,
  FeatureFlag,
  FlagEvalResult,
  FeatureFlagCallback,
} from './types';

const DEFAULT_BASE_URL = 'https://flags.rivium.co';

/**
 * RiviumFlags - Server-side Feature Flags SDK for Node.js
 *
 * @example
 * ```typescript
 * const flags = new RiviumFlags({
 *   apiKey: 'rv_live_xxx',
 *   serverSecret: 'your-server-secret',
 * });
 * await flags.init();
 *
 * if (flags.isEnabled('dark-mode', { userId: 'user-123' })) {
 *   // dark mode enabled
 * }
 * ```
 */
export class RiviumFlags {
  private config: RiviumFlagsConfig;
  private flags: FeatureFlag[] = [];
  private initialized = false;
  private callback?: FeatureFlagCallback;

  constructor(config: RiviumFlagsConfig) {
    if (!config.apiKey) throw new Error('apiKey is required');
    if (!config.serverSecret) throw new Error('serverSecret is required');
    this.config = {
      ...config,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    };
  }

  /**
   * Initialize the SDK by fetching flags from the server
   */
  async init(callback?: FeatureFlagCallback): Promise<void> {
    this.callback = callback;
    await this.fetchFlags();
    this.initialized = true;
    this.callback?.('initialized', { count: this.flags.length });
  }

  /**
   * Check if a feature flag is enabled
   */
  isEnabled(
    flagKey: string,
    context?: { userId?: string; userAttributes?: Record<string, any> },
    defaultValue = false,
  ): boolean {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return defaultValue;
    return this.evaluateFlag(flag, context?.userId, context?.userAttributes).enabled;
  }

  /**
   * Get the value of a feature flag
   */
  getValue(
    flagKey: string,
    context?: { userId?: string; userAttributes?: Record<string, any> },
    defaultValue?: any,
  ): any {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return defaultValue;
    const result = this.evaluateFlag(flag, context?.userId, context?.userAttributes);
    return result.value ?? defaultValue;
  }

  /**
   * Evaluate a flag and get the full result
   */
  evaluate(
    flagKey: string,
    context?: { userId?: string; userAttributes?: Record<string, any> },
  ): FlagEvalResult {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return { enabled: false, value: false };
    return this.evaluateFlag(flag, context?.userId, context?.userAttributes);
  }

  /**
   * Get all flags
   */
  getAll(): FeatureFlag[] {
    return [...this.flags];
  }

  /**
   * Refresh flags from the server
   */
  async refresh(): Promise<void> {
    await this.fetchFlags();
    this.callback?.('featureFlagsRefreshed', { count: this.flags.length });
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.flags = [];
    this.initialized = false;
  }

  /**
   * Dispose the SDK instance
   */
  dispose(): void {
    this.reset();
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  private get flagsUrl(): string {
    const base = `${this.config.baseUrl}/public/flags`;
    if (this.config.environment) {
      return `${base}?environment=${encodeURIComponent(this.config.environment)}`;
    }
    return base;
  }

  private async fetchFlags(): Promise<void> {
    try {
      const response = await fetch(this.flagsUrl, {
        headers: {
          'x-api-key': this.config.apiKey,
          'x-server-secret': this.config.serverSecret,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as { flags?: FeatureFlag[] };
      this.flags = data.flags || [];

      if (this.config.debug) {
        console.log(`[RiviumFlags] Fetched ${this.flags.length} flags`);
      }
    } catch (error) {
      if (this.config.debug) {
        console.error('[RiviumFlags] Failed to fetch flags:', error);
      }
      this.callback?.('error', { message: `Failed to fetch flags: ${error}` });
    }
  }

  private evaluateFlag(
    flag: FeatureFlag,
    userId?: string,
    userAttributes?: Record<string, any>,
  ): FlagEvalResult {
    if (!flag.enabled) {
      return { enabled: false, value: flag.defaultValue ?? false };
    }

    // Check targeting rules
    if (flag.targetingRules && Object.keys(flag.targetingRules).length > 0) {
      if (!this.evaluateTargetingRules(flag.targetingRules, userAttributes || {})) {
        return { enabled: false, value: flag.defaultValue ?? false };
      }
    }

    // Check rollout percentage
    if (userId) {
      const bucket = this.getBucket(userId, flag.key);
      if (bucket >= flag.rolloutPercentage) {
        return { enabled: false, value: flag.defaultValue ?? false };
      }
    }

    // Multivariate flag
    if (flag.variants && flag.variants.length > 0) {
      const variantBucket = this.getVariantBucket(userId || '', flag.key);
      let cumulative = 0;
      for (const variant of flag.variants) {
        cumulative += variant.weight;
        if (variantBucket < cumulative) {
          return { enabled: true, value: variant.value, variant: variant.key };
        }
      }
      return {
        enabled: true,
        value: flag.variants[0].value,
        variant: flag.variants[0].key,
      };
    }

    return { enabled: true, value: true };
  }

  private evaluateTargetingRules(
    rules: Record<string, any>,
    userContext: Record<string, any>,
  ): boolean {
    // Handle nested { operator, rules } format from dashboard
    if (rules.rules && Array.isArray(rules.rules)) {
      const op = (rules.operator || 'AND').toUpperCase();
      if (op === 'OR') return rules.rules.some((r: any) => this.evaluateNestedRule(r, userContext));
      return rules.rules.every((r: any) => this.evaluateNestedRule(r, userContext));
    }
    // Legacy flat format
    for (const [key, rule] of Object.entries(rules)) {
      if (!this.evaluateRule(key, rule, userContext)) {
        return false;
      }
    }
    return true;
  }

  private evaluateNestedRule(
    rule: { attribute: string; operator: string; value: any },
    context: Record<string, any>,
  ): boolean {
    const userValue = context[rule.attribute];
    switch (rule.operator) {
      case 'equals': return userValue === rule.value;
      case 'not_equals': case 'notEquals': return userValue !== rule.value;
      case 'in': {
        const list = typeof rule.value === 'string' ? rule.value.split(',').map((s: string) => s.trim()) : rule.value;
        return Array.isArray(list) && list.includes(userValue);
      }
      case 'not_in': case 'notIn': {
        const list = typeof rule.value === 'string' ? rule.value.split(',').map((s: string) => s.trim()) : rule.value;
        return !Array.isArray(list) || !list.includes(userValue);
      }
      case 'greater_than': case 'greaterThan': return typeof userValue === 'number' && userValue > Number(rule.value);
      case 'less_than': case 'lessThan': return typeof userValue === 'number' && userValue < Number(rule.value);
      case 'contains': return typeof userValue === 'string' && userValue.includes(String(rule.value));
      case 'regex': return typeof userValue === 'string' && new RegExp(String(rule.value)).test(userValue);
      case 'exists': return rule.value ? userValue != null : userValue == null;
      default: return userValue === rule.value;
    }
  }

  private evaluateRule(
    key: string,
    rule: any,
    context: Record<string, any>,
  ): boolean {
    const value = context[key];

    if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
      if ('equals' in rule) return value === rule.equals;
      if ('notEquals' in rule) return value !== rule.notEquals;
      if ('in' in rule && Array.isArray(rule.in)) return rule.in.includes(value);
      if ('notIn' in rule && Array.isArray(rule.notIn)) return !rule.notIn.includes(value);
      if ('greaterThan' in rule) return typeof value === 'number' && value > rule.greaterThan;
      if ('lessThan' in rule) return typeof value === 'number' && value < rule.lessThan;
      if ('greaterThanOrEqual' in rule) return typeof value === 'number' && value >= rule.greaterThanOrEqual;
      if ('lessThanOrEqual' in rule) return typeof value === 'number' && value <= rule.lessThanOrEqual;
      if ('contains' in rule) return typeof value === 'string' && value.includes(rule.contains);
      if ('regex' in rule) return typeof value === 'string' && new RegExp(rule.regex).test(value);
      if ('exists' in rule) return rule.exists ? value != null : value == null;
      if ('and' in rule && Array.isArray(rule.and)) {
        return rule.and.every((r: any) => this.evaluateRule(key, r, context));
      }
      if ('or' in rule && Array.isArray(rule.or)) {
        return rule.or.some((r: any) => this.evaluateRule(key, r, context));
      }
    }

    return value === rule;
  }

  private getBucket(userId: string, salt: string): number {
    const hash = crypto.createHash('md5').update(`${userId}:${salt}`).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 100;
  }

  private getVariantBucket(userId: string, flagKey: string): number {
    const hash = crypto.createHash('md5').update(`${userId}:${flagKey}:variant`).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 100;
  }
}
