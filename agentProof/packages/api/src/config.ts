import { createHash } from 'node:crypto';
import type { PolicyDocument } from '@agentproof/sdk';

export type ApiMode = 'simulation' | 'production';

export interface RuntimeConfig {
  mode: ApiMode;
  adminToken?: string;
  graph?: { endpoint: string; apiKey: string };
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv, policy: PolicyDocument): RuntimeConfig {
  const mode = env.AGENTPROOF_MODE === 'production' ? 'production' : 'simulation';
  const graph =
    env.GRAPH_ENDPOINT && env.GRAPH_API_KEY
      ? { endpoint: env.GRAPH_ENDPOINT, apiKey: env.GRAPH_API_KEY }
      : undefined;

  const missing: string[] = [];
  if (mode === 'production') {
    if (!env.SEPOLIA_RPC_URL) missing.push('SEPOLIA_RPC_URL');
    if (!graph) missing.push('GRAPH_ENDPOINT + GRAPH_API_KEY');
    if (policy.chainId !== 11_155_111) missing.push('policy.chainId must be 11155111');
    if (policy.asset.decimals !== 6) missing.push('policy.asset.decimals must be 6');
    if (/^0x0{40}$/i.test(policy.enforcement.hook)) missing.push('policy.enforcement.hook must be deployed');
    if (/^0x0{40}$/i.test(policy.enforcement.account)) missing.push('policy.enforcement.account must be deployed');
  }

  if (env.OWNER_PRIVATE_KEY || env.PRIVATE_KEY) {
    missing.push('owner private keys must not be present in the API/agent process');
  }

  if (missing.length) throw new PreflightError(`AgentProof preflight failed: ${missing.join('; ')}`);
  return { mode, adminToken: env.AGENTPROOF_ADMIN_TOKEN, graph };
}

export function tokenFingerprint(token?: string): string | undefined {
  if (!token) return undefined;
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
