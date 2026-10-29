import { MonitorSettings, Provider } from '../core/model';

export const AGENT_VERSION = '0.6.0';
export const PROTOCOL_VERSION = 1;
export interface AgentConfig {
  providers: Provider[];
  settings: MonitorSettings;
  backupHours: number;
  pythonPath: string;
  sqliteHome?: string;
  codexPath?: string;
}
export interface AgentState {
  revision: number;
  config: AgentConfig;
  monitorEnabled: boolean;
  backupEnabled: boolean;
  proxy?: { group: string; model: string; port: number };
  events: { at: number; message: string }[];
  checks?: Record<string, { text?: CheckResult; tools?: CheckResult }>;
}
export interface CheckResult { ok: boolean; at: number; reason: string; status?: number }
export interface AgentStatus {
  version: string; protocol: number; home: string; pid: number;
  mode: 'detached' | 'systemd'; revision: number; config: AgentConfig;
  monitoring: boolean; checking: boolean; nextCheck: number;
  autoBackup: boolean; nextBackup: number; backingUp: boolean;
  proxy: { group: string; model: string; port: number; activeProvider: string } | null;
  proxyError: string; keyIds: string[];
  health: Record<string, any>; history: Record<string, { at: number; ok: boolean }[]>;
  events: { at: number; message: string }[];
  checks?: Record<string, { text?: CheckResult; tools?: CheckResult }>;
  accounts?: import('../core/accounts').AccountSummary[];
  switchJob?: import('../core/switch-queue').SwitchJob;
  configChecks?: Record<string, Awaited<ReturnType<typeof import('../core/configuration')['inspectProvider']>>>;
  capabilities: { history: true; existingVSCodeControl: false };
}
export interface Operation {
  id: string; action: string; digest: string; at: number;
  state: 'running' | 'success' | 'error' | 'unknown'; result?: unknown; error?: string;
}
