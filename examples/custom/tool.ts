// Copy into a task, add extensions: [tool.ts], and include its name in agent.tools.
// No network, credential or dependency installation is needed for this example.
import type { CustomTool } from 'pi-sentinel';
const tool: CustomTool = {
  name: 'check_reference_format',
  manifest: {
    name: 'check_reference_format',
    version: '1.0.0',
    effect: 'read',
    timeoutSeconds: 1,
    maxOutputBytes: 1000,
  },
  description: 'Check a project/path#IID reference format without accessing any service.',
  parameters: {
    type: 'object',
    properties: { ref: { type: 'string' } },
    required: ['ref'],
    additionalProperties: false,
  },
  execute: async (args) => ({
    valid: /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+#[1-9]\d*$/.test(String(args.ref)),
  }),
};
export default tool;
