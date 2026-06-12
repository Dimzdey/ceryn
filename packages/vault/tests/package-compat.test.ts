import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as {
  type?: string;
  exports?: Record<string, Record<string, string>>;
};
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('package compatibility contract', () => {
  it('declares ESM package exports', () => {
    expect(packageJson.type).toBe('module');
    expect(packageJson.exports?.['.']?.import).toBe('./dist/index.js');
    expect(packageJson.exports?.['.']?.types).toBe('./dist/index.d.ts');
    expect(packageJson.exports?.['.']).not.toHaveProperty('require');
    expect(packageJson.exports?.['./compat']?.import).toBe('./dist/compat.js');
    expect(packageJson.exports?.['./compat']?.types).toBe('./dist/compat.d.ts');
    expect(packageJson.exports?.['./compat']).not.toHaveProperty('require');
  });

  it('documents ESM-only package format', () => {
    expect(readme).toContain('## Package Format');
    expect(readme).toContain('published as an ESM package');
    expect(readme).toContain('CommonJS `require()` is not part of the supported package contract');
  });
});
