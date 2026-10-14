import type { AgentResult, Evidence, Tool } from './contracts.js';
export interface FlowContext {
  evidence: Evidence;
  agent: { run(options?: { instructions?: string; tools?: string[] }): Promise<AgentResult> };
}
export type CustomFlow = (context: FlowContext) => Promise<AgentResult>;
export const defineFlow = (flow: CustomFlow) => flow;
export interface ToolManifest {
  name: string;
  version: string;
  effect: 'read';
  timeoutSeconds: number;
  maxOutputBytes: number;
}
export type CustomTool = Tool & { manifest: ToolManifest };
export const defineTool = (tool: CustomTool) => tool;
