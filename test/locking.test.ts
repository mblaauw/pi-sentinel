import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configuration, mockServer, json } from './helpers.js';

test(
  'the real CLI prevents two workers from owning one state database',
  { timeout: 20000 },
  async () => {
    let ready: () => void = () => {};
    const observed = new Promise<void>((done) => {
      ready = done;
    });
    const server = await mockServer((_req, res) => {
      json(res, []);
      ready();
    });
    const { root, dir } = await configuration(server.url + '/api/v4', {
      trigger: { mode: 'continuous', intervalSeconds: 1, jitterSeconds: 0 },
    });
    const args = [
      '--import',
      'tsx',
      'src/cli.ts',
      'worker',
      dir,
      '--state',
      join(root, 'state.sqlite'),
      '--port',
      '0',
    ];
    const first = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    first.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    try {
      await Promise.race([
        observed,
        new Promise((_, fail) =>
          first.once('exit', (code) => fail(new Error(`Worker exited ${code}: ${errors}`))),
        ),
        new Promise((_, fail) =>
          setTimeout(() => fail(new Error('Worker did not reach discovery')), 10000).unref(),
        ),
      ]);
      const second = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'ignore' });
      const code = await new Promise<number | null>((done, fail) => {
        second.once('error', fail);
        second.once('exit', done);
      });
      assert.equal(code, 75);
    } finally {
      first.kill('SIGTERM');
      await new Promise<void>((done) => {
        if (first.exitCode !== null) done();
        else first.once('exit', () => done());
      });
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
