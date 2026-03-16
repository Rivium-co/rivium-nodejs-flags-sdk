export interface RiviumFlagsConfig {
  apiKey: string;
  serverSecret: string;
  environment?: string;
  baseUrl?: string;
  debug?: boolean;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules?: Record<string, any>;
  variants?: FlagVariant[];
  defaultValue?: any;
}

export interface FlagVariant {
  key: string;
  value: any;
  weight: number;
}

export interface FlagEvalResult {
  enabled: boolean;
  value: any;
  variant?: string;
}

export type FeatureFlagCallback = (event: string, data?: Record<string, any>) => void;
