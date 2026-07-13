import { readFileSync } from 'node:fs';

describe('warm-process benchmark methodology', () => {
  const source = readFileSync(new URL('../benchmarks/benchmark.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  const methodology = readFileSync(new URL('../benchmarks/README.md', import.meta.url), 'utf8');

  it('does not describe a Tinybench task as process cold boot', () => {
    expect(source).toContain('Fresh container + first request (warm process)');
    expect(source).not.toContain("name: 'Cold boot + first request'");
    expect(source).not.toContain('`${a.name}: Cold boot + first request`');
  });

  it('labels unavailable tails instead of publishing unstable percentiles', () => {
    expect(source).toContain('percentileEligibility');
    expect(source).toContain('insufficient samples');
  });

  it('supports seeded ordering, raw samples, and histogram diagnostics', () => {
    expect(source).toContain('BENCH_SEED');
    expect(source).toContain('deterministicShuffle(taskSpecs, seed)');
    expect(source).not.toContain('bench.tasks.splice');
    expect(source).toContain('BENCH_TIME_MS');
    expect(source).toContain('BENCH_WARMUP_MS');
    expect(source).toContain('BENCH_OUTPUT_JSON');
    expect(source).toContain('BENCH_HISTOGRAM');
  });

  it('does not publish same-process retained heap as a headline result', () => {
    expect(source).not.toContain(
      '=== Approximate retained heap after cold boot + first request ==='
    );
  });

  it('registers the unused async entry for Tsyringe and TypeDI too', () => {
    const tsyringe = source.slice(
      source.indexOf('function buildTsyringeAdapter'),
      source.indexOf('function buildInversifyAdapter')
    );
    const typedi = source.slice(
      source.indexOf('function buildTypeDIAdapter'),
      source.indexOf('function buildNeedleAdapter')
    );

    expect(tsyringe).toContain('container.register(AsyncDbT');
    expect(typedi).toContain('id: AsyncDbT');
  });

  it('provides explicit warm and isolated process benchmark commands', () => {
    expect(packageJson.scripts['bench:warm']).toBe(packageJson.scripts.bench);
    expect(packageJson.scripts['bench:isolated']).toContain('benchmarks/isolated/orchestrator.mjs');
    expect(methodology).toContain('Fresh container + first request (warm process)');
    expect(methodology).toContain('BENCH_ISOLATED_RUNS');
    expect(methodology).toContain('post-import baseline');
  });
});
