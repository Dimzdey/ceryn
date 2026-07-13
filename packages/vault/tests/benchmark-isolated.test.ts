import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const orchestratorPath = resolve(packageRoot, 'benchmarks/isolated/orchestrator.mjs');
const adapters = ['ceryn', 'tsyringe', 'inversify', 'typedi', 'needle'] as const;

function buildIfNeeded(): void {
  if (existsSync(resolve(packageRoot, 'dist/index.js'))) return;
  execFileSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' });
}

describe('isolated benchmark child', () => {
  beforeAll(buildIfNeeded);

  it.each(adapters)('%s satisfies the shared semantic contract', async (adapter) => {
    const fixtureUrl = pathToFileURL(
      resolve(packageRoot, `benchmarks/isolated/adapters/${adapter}.mjs`)
    ).href;
    const fixture = (await import(/* @vite-ignore */ fixtureUrl)) as {
      verifyContract(): Promise<Record<string, unknown>>;
    };

    await expect(fixture.verifyContract()).resolves.toMatchObject({
      registrationCount: 23,
      resultConsumed: true,
      controllerSingleton: true,
      parentSingleton: true,
      scopedStableWithinScope: true,
      scopedDistinctAcrossScopes: true,
      requestOverride: true,
    });
  });

  it('orchestrates independent timing, contract, and memory processes', () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), 'ceryn-isolated-benchmark-'));
    const outputPath = resolve(outputDirectory, 'results.json');
    try {
      const output = execFileSync(process.execPath, ['--expose-gc', orchestratorPath], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BENCH_ISOLATED_ADAPTERS: 'ceryn',
          BENCH_ISOLATED_RUNS: '1',
          BENCH_ISOLATED_SUBSEQUENT: '5',
          BENCH_OUTPUT_JSON: outputPath,
          BENCH_SEED: '42',
        },
      });
      const results = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        contracts: Array<{ contract: Record<string, unknown> }>;
        timing: Array<Record<string, unknown>>;
        memory: Array<Record<string, unknown>>;
      };

      expect(output).toContain('=== Isolated Process DI Benchmark ===');
      expect(output).toContain('Semantic contract: PASS');
      expect(results.contracts[0]?.contract).toMatchObject({ registrationCount: 23 });
      expect(results.timing[0]).toMatchObject({
        adapter: 'Ceryn',
        firstResult: 'db:users',
        subsequentCount: 5,
      });
      for (const field of [
        'spawnToReadyNs',
        'importNs',
        'buildNs',
        'firstResolutionNs',
        'subsequentNs',
      ]) {
        expect(results.timing[0]?.[field]).toEqual(expect.any(Number));
        expect(results.timing[0]?.[field]).toBeGreaterThan(0);
      }
      expect(results.memory[0]).toMatchObject({
        adapter: 'Ceryn',
        firstResult: 'db:users',
        retainedHeapBytes: expect.any(Number),
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
}, 30_000);
