import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deterministicShuffle, summarizeDistribution } from '../lib/statistics.mjs';
import { PROTOCOL_PREFIX } from './protocol.mjs';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const childPath = resolve(currentDirectory, 'child.mjs');
const allAdapters = [
  { key: 'ceryn', name: 'Ceryn' },
  { key: 'tsyringe', name: 'Tsyringe' },
  { key: 'inversify', name: 'Inversify' },
  { key: 'typedi', name: 'TypeDI' },
  { key: 'needle', name: 'Needle' },
];

function positiveInteger(value, fallback, label) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (value !== undefined) throw new Error(`${label} must be a positive integer`);
    return fallback;
  }
  return parsed;
}

function selectedAdapters() {
  const requested = process.env.BENCH_ISOLATED_ADAPTERS;
  if (!requested) return allAdapters;
  const keys = new Set(requested.split(',').map((value) => value.trim().toLowerCase()));
  const selected = allAdapters.filter(
    (adapter) => keys.has(adapter.key) || keys.has(adapter.name.toLowerCase())
  );
  const known = new Set(allAdapters.flatMap((adapter) => [adapter.key, adapter.name.toLowerCase()]));
  const unknown = [...keys].filter((key) => key && !known.has(key));
  if (unknown.length > 0) throw new Error(`Unknown adapters: ${unknown.join(', ')}`);
  if (selected.length === 0) throw new Error('BENCH_ISOLATED_ADAPTERS selected no adapters');
  return selected;
}

function now() {
  return process.hrtime.bigint();
}

function elapsedNs(start, end = now()) {
  return Number(end - start);
}

function runChild(mode, adapter, subsequentCount) {
  return new Promise((resolveRun, rejectRun) => {
    const start = now();
    const fixturePath = resolve(currentDirectory, 'adapters', `${adapter.key}.mjs`);
    const child = spawn(
      process.execPath,
      ['--expose-gc', childPath, mode, fixturePath, String(subsequentCount)],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let readyNs;
    let resultNs;
    let resultMessage;
    let errorMessage;

    const consumeLine = (line) => {
      if (!line.startsWith(PROTOCOL_PREFIX)) return;
      const message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
      if (message.type === 'ready') readyNs = elapsedNs(start);
      if (message.type === 'result') {
        resultNs = elapsedNs(start);
        resultMessage = message;
      }
      if (message.type === 'error') errorMessage = message;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (stdout) consumeLine(stdout);
      if (code !== 0 || errorMessage || !resultMessage || readyNs === undefined) {
        const detail = errorMessage?.stack ?? errorMessage?.message ?? stderr.trim() ?? 'no result';
        rejectRun(new Error(`${adapter.name} ${mode} child failed: ${detail}`));
        return;
      }
      resolveRun({ ...resultMessage, spawnToReadyNs: readyNs, spawnToResultNs: resultNs });
    });
  });
}

function formatNs(ns) {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)}μs`;
  return `${Math.round(ns)}ns`;
}

function formatBytes(bytes) {
  const sign = bytes >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(bytes) / 1024).toFixed(1)} KiB`;
}

function formatSummary(values, formatter = formatNs) {
  const summary = summarizeDistribution(values);
  return `${formatter(summary.median)} median, IQR ${formatter(summary.iqr)}, range ${formatter(
    summary.min
  )}..${formatter(summary.max)}`;
}

function contractPasses(contract) {
  return (
    contract.registrationCount === 23 &&
    contract.resultConsumed === true &&
    contract.controllerSingleton === true &&
    contract.parentSingleton === true &&
    contract.scopedStableWithinScope === true &&
    contract.scopedDistinctAcrossScopes === true &&
    contract.requestOverride === true
  );
}

async function main() {
  const adapters = selectedAdapters();
  const runs = positiveInteger(process.env.BENCH_ISOLATED_RUNS, 20, 'BENCH_ISOLATED_RUNS');
  const subsequentCount = positiveInteger(
    process.env.BENCH_ISOLATED_SUBSEQUENT,
    1_000,
    'BENCH_ISOLATED_SUBSEQUENT'
  );
  const parsedSeed = Number.parseInt(process.env.BENCH_SEED ?? '', 10);
  const seed = Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : Date.now() >>> 0;

  console.log('=== Isolated Process DI Benchmark ===');
  console.log(`Node ${process.version}  ${process.platform} ${process.arch}`);
  console.log(`CPU ${cpus()[0]?.model ?? 'unknown'}  ${cpus().length} logical cores`);
  console.log(`Seed: ${seed}  repetitions: ${runs}  subsequent resolutions/process: ${subsequentCount}`);
  console.log(`Adapters: ${adapters.map((adapter) => adapter.name).join(', ')}`);

  const contracts = [];
  for (const adapter of deterministicShuffle(adapters, seed)) {
    contracts.push(await runChild('contract', adapter, subsequentCount));
  }
  const contractOk = contracts.every((row) => contractPasses(row.contract));
  console.log(`\nSemantic contract: ${contractOk ? 'PASS' : 'FAIL'}`);
  for (const row of contracts) {
    console.log(
      `${row.adapter.padEnd(12)} ${contractPasses(row.contract) ? 'PASS' : 'FAIL'}  registrations ${
        row.contract.registrationCount
      }  decorators ${String(row.capabilities.decorators)}`
    );
  }
  if (!contractOk) throw new Error('At least one adapter failed the shared semantic contract');

  const timing = [];
  for (let run = 0; run < runs; run++) {
    for (const adapter of deterministicShuffle(adapters, seed + run)) {
      timing.push({ run, ...(await runChild('timing', adapter, subsequentCount)) });
    }
  }

  const memory = [];
  for (let run = 0; run < runs; run++) {
    for (const adapter of deterministicShuffle(adapters, seed ^ (run + 0x9e3779b9))) {
      memory.push({ run, ...(await runChild('memory', adapter, subsequentCount)) });
    }
  }

  console.log('\n=== Process startup and resolution (independent process runs) ===');
  const timingPhases = [
    ['spawnToReadyNs', 'Process spawn → child ready'],
    ['importNs', 'Framework + fixture import'],
    ['buildNs', 'Container creation + registration'],
    ['firstResolutionNs', 'First graph resolution + consumption'],
    ['subsequentPerResolutionNs', 'Subsequent resolution + consumption'],
    ['spawnToResultNs', 'Process spawn → timing result'],
  ];
  for (const adapter of adapters) {
    console.log(`\n${adapter.name}`);
    const rows = timing.filter((row) => row.adapter === adapter.name);
    for (const [field, label] of timingPhases) {
      const values = rows.map((row) =>
        field === 'subsequentPerResolutionNs'
          ? row.subsequentNs / row.subsequentCount
          : row[field]
      );
      console.log(`  ${label.padEnd(39)} ${formatSummary(values)}`);
    }
  }

  console.log('\n=== Directional retained heap (post-import baseline, independent processes) ===');
  for (const adapter of adapters) {
    const values = memory
      .filter((row) => row.adapter === adapter.name)
      .map((row) => row.retainedHeapBytes);
    console.log(`${adapter.name.padEnd(12)} ${formatSummary(values, formatBytes)}`);
  }

  console.log('\nCapabilities and disposal semantics:');
  for (const row of contracts) {
    console.log(`${row.adapter.padEnd(12)} ${JSON.stringify(row.capabilities)}`);
  }
  console.log('\nMemory values are GC-assisted directional estimates, not stable process limits.');
  console.log('Use raw JSON and repeated runs when investigating GC or multimodal behavior.');

  if (process.env.BENCH_OUTPUT_JSON) {
    const outputPath = resolve(process.env.BENCH_OUTPUT_JSON);
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        {
          suite: 'isolated-process',
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpu: cpus()[0]?.model ?? 'unknown',
          },
          seed,
          runs,
          subsequentCount,
          contracts,
          timing,
          memory,
        },
        null,
        2
      )}\n`
    );
    console.log(`Raw process-level results written to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
