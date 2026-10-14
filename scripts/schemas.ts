import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { taskSchema, environmentSchema, resultSchema } from '../src/contracts.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  task: taskSchema,
  environment: environmentSchema,
  result: resultSchema,
}))
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(zodToJsonSchema(schema, { name }), null, 2) + '\n',
  );
