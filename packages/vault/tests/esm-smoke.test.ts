import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('ESM packaging', () => {
  it('built dist/index.js loads under Node native ESM', () => {
    const distPath = resolve(__dirname, '../dist/index.js');

    // Skip if dist not built
    if (!existsSync(distPath)) {
      return;
    }

    const result = execSync(
      `node --input-type=module -e "import('${distPath}').then(m => console.log(Object.keys(m).length))"`,
      {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      }
    );

    // Strip any ANSI escape codes before parsing
    // eslint-disable-next-line no-control-regex
    const clean = result.replace(/\x1B\[[0-9;]*m/g, '').trim();
    const exportCount = parseInt(clean, 10);
    expect(exportCount).toBeGreaterThan(10);
  });
});
