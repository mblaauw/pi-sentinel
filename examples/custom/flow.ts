// Copy into a task, set flow.type=custom and flow.file=flow.ts.
// Tools can be narrowed for a stage; the host prevents widening the allowlist.
import type { CustomFlow } from 'sentinel-pi';
const flow: CustomFlow = async (ctx) =>
  ctx.agent.run({
    instructions:
      'Make one focused assessment. Clearly identify uncertainty before submitting the result.',
  });
export default flow;
