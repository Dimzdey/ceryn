import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('focused Vault benchmark methodology', () => {
  const source = readFileSync(new URL('../benchmarks/focused.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };

  it('exposes fixed Ceryn-only tasks and raw process output', () => {
    expect(packageJson.scripts['bench:focused']).toContain('benchmarks/focused.ts');
    for (const name of [
      'cached resolve 1k',
      'cached tryResolve 1k',
      'canResolve + resolve 1k',
      'scoped cycle 1k',
      'metadata + build 100',
      'bound scope async cached 100',
      'root async cached 100',
    ]) {
      expect(source).toContain(name);
    }
    expect(source).toContain("suite: 'vault-focused'");
    expect(source).toContain('BENCH_OUTPUT_JSON');
    expect(source).toContain('samplesNs');
  });
});
