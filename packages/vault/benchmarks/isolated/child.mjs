import { PerformanceObserver } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { sendMessage } from './protocol.mjs';

const [mode, adapterPath, subsequentArg = '1000'] = process.argv.slice(2);
const subsequentCount = Number.parseInt(subsequentArg, 10);
const gcEvents = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEvents.push({ durationMs: entry.duration, kind: entry.detail?.kind ?? null });
  }
});
observer.observe({ entryTypes: ['gc'] });

function now() {
  return process.hrtime.bigint();
}

function elapsedNs(start, end = now()) {
  return Number(end - start);
}

function forceGc(times) {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Memory mode requires Node --expose-gc');
  }
  for (let index = 0; index < times; index++) globalThis.gc();
}

async function flushGcEntries() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadFixture() {
  if (!adapterPath) throw new Error('Adapter fixture path is required');
  return import(pathToFileURL(adapterPath).href);
}

async function runTiming() {
  const importStart = now();
  const fixture = await loadFixture();
  const importEnd = now();

  const buildStart = now();
  const container = fixture.buildContainer();
  const buildEnd = now();

  const firstStart = now();
  const firstResult = fixture.resolveController(container, 'users').handle();
  const firstEnd = now();

  let checksum = firstResult.length;
  const subsequentStart = now();
  for (let index = 0; index < subsequentCount; index++) {
    checksum += fixture.resolveController(container, 'users').handle().length;
  }
  const subsequentEnd = now();
  await flushGcEntries();

  sendMessage({
    type: 'result',
    mode: 'timing',
    adapter: fixture.name,
    registrationCount: fixture.registrationCount,
    capabilities: fixture.capabilities,
    importNs: elapsedNs(importStart, importEnd),
    buildNs: elapsedNs(buildStart, buildEnd),
    firstResolutionNs: elapsedNs(firstStart, firstEnd),
    subsequentNs: elapsedNs(subsequentStart, subsequentEnd),
    subsequentCount,
    firstResult,
    checksum,
    gcEvents,
  });
  await fixture.release(container);
}

async function runContract() {
  const fixture = await loadFixture();
  const contract = await fixture.verifyContract();
  sendMessage({
    type: 'result',
    mode: 'contract',
    adapter: fixture.name,
    capabilities: fixture.capabilities,
    contract,
  });
}

async function runMemory() {
  const fixture = await loadFixture();
  forceGc(3);
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const container = fixture.buildContainer();
  const firstResult = fixture.resolveController(container, 'users').handle();
  forceGc(3);
  const retainedHeapBytes = process.memoryUsage().heapUsed - baselineHeapBytes;
  await flushGcEntries();
  sendMessage({
    type: 'result',
    mode: 'memory',
    adapter: fixture.name,
    registrationCount: fixture.registrationCount,
    baselineHeapBytes,
    retainedHeapBytes,
    firstResult,
    gcEvents,
  });
  await fixture.release(container);
}

sendMessage({ type: 'ready', pid: process.pid });

try {
  if (mode === 'timing') await runTiming();
  else if (mode === 'contract') await runContract();
  else if (mode === 'memory') await runMemory();
  else throw new Error(`Unknown isolated benchmark mode: ${mode ?? '<missing>'}`);
} catch (error) {
  sendMessage({
    type: 'error',
    mode,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  observer.disconnect();
}
