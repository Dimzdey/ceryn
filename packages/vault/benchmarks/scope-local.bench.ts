/**
 * Scope-Local Registration Performance Benchmark
 *
 * Measures the performance impact of scope-local registrations on the hot path.
 *
 * Scenarios:
 * 1. Baseline: Singleton resolution without scope
 * 2. Scope (no override): Resolution with scope, no scope-local registrations
 * 3. Scope-local override: Resolution with scope-local registration
 * 4. Scope-local miss: Check scope-local, fall back to singleton
 */

import { Bench } from 'tinybench';
import { Genesis } from '../src/api/genesis.js';
import { token } from '../src/core/token.js';
import { Relic, Summon, Vault } from '../src/decorators/index.js';

// ==================== Test Setup ====================

const ServiceAT = token<ServiceA>('ServiceA');
const ServiceBT = token<ServiceB>('ServiceB');
const ServiceCT = token<ServiceC>('ServiceC');
const OverridableT = token<Overridable>('Overridable');

@Relic({ provide: ServiceAT })
class ServiceA {
  value = 'A';
}

@Relic({ provide: ServiceBT })
class ServiceB {
  constructor(@Summon(ServiceAT) public a: ServiceA) {}
}

@Relic({ provide: ServiceCT })
class ServiceC {
  constructor(
    @Summon(ServiceAT) public a: ServiceA,
    @Summon(ServiceBT) public b: ServiceB
  ) {}
}

@Relic({ provide: OverridableT })
class Overridable {
  value = 'original';
}

@Vault({
  relics: [ServiceA, ServiceB, ServiceC, Overridable],
  reveal: [ServiceAT, ServiceBT, ServiceCT, OverridableT],
})
class TestVault {}

const genesis = Genesis.from(TestVault);

// ==================== Benchmark ====================

const bench = new Bench({
  name: 'Scope-Local Registration Performance',
  time: 1000,
  iterations: 10,
  warmupIterations: 5,
});

// Scenario 1: Baseline - Singleton resolution without scope
bench.add('baseline: singleton (no scope)', () => {
  const service = genesis.resolve(ServiceCT);
  if (service.a.value !== 'A') throw new Error('Invalid');
});

// Scenario 2: Resolution with scope but no scope-local registrations
bench.add('with scope (no override)', () => {
  const scope = genesis.createScope();
  const service = scope.resolve(ServiceCT);
  if (service.a.value !== 'A') throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 3: Scope-local override (fast path hit)
bench.add('scope-local override', () => {
  const scope = genesis.createScope();
  const override = new ServiceA();
  override.value = 'overridden';
  scope.provide(ServiceAT, override);
  const service = scope.resolve(ServiceAT);
  if (service.value !== 'overridden') throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 4: Check scope-local, fall back to singleton
bench.add('scope-local check + fallback', () => {
  const scope = genesis.createScope();
  // Provide B but not A, so A falls back to singleton
  scope.provide(ServiceBT, new ServiceB(new ServiceA()));
  const serviceA = scope.resolve(ServiceAT); // Falls back to singleton
  const serviceB = scope.resolve(ServiceBT); // Hits scope-local
  if (serviceA.value !== 'A' || !serviceB.a) throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 5: Deep dependency chain with scope
bench.add('deep chain with scope', () => {
  const scope = genesis.createScope();
  const service = scope.resolve(ServiceCT); // A -> B -> C
  if (service.b.a.value !== 'A') throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 6: Deep chain with override
bench.add('deep chain + override', () => {
  const scope = genesis.createScope();
  const overrideA = new ServiceA();
  overrideA.value = 'custom';
  scope.provide(ServiceAT, overrideA);
  // Directly resolve overridden service
  const serviceA = scope.resolve(ServiceAT);
  if (serviceA.value !== 'custom') throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 7: Multiple scope-local registrations
bench.add('multiple scope-locals', () => {
  const scope = genesis.createScope();
  scope.provide(ServiceAT, new ServiceA());
  scope.provide(ServiceBT, new ServiceB(new ServiceA()));
  scope.provide(ServiceCT, new ServiceC(new ServiceA(), new ServiceB(new ServiceA())));
  const a = scope.resolve(ServiceAT);
  const b = scope.resolve(ServiceBT);
  const c = scope.resolve(ServiceCT);
  if (!a || !b || !c) throw new Error('Invalid');
  scope.disposeSync();
});

// Scenario 8: Burst - Many resolutions with scope
bench.add('burst: 1000 resolutions + scope', () => {
  const scope = genesis.createScope();
  for (let i = 0; i < 1000; i++) {
    const service = scope.resolve(ServiceAT);
    if (service.value !== 'A') throw new Error('Invalid');
  }
  scope.disposeSync();
});

// Scenario 9: Burst - Many resolutions without scope (baseline)
bench.add('burst: 1000 resolutions (baseline)', () => {
  for (let i = 0; i < 1000; i++) {
    const service = genesis.resolve(ServiceAT);
    if (service.value !== 'A') throw new Error('Invalid');
  }
});

// ==================== Run Benchmark ====================

await bench.run();

console.log('\n' + '='.repeat(80));
console.log('Scope-Local Registration Performance Results');
console.log('='.repeat(80) + '\n');

console.table(
  bench.tasks.map((task) => ({
    'Test Case': task.name,
    'ops/sec': task.result?.period
      ? `${(1000 / task.result.period).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'N/A',
    'avg (ms)': task.result?.period ? task.result.period.toFixed(4) : 'N/A',
    hz: task.result?.hz ? task.result.hz.toFixed(2) : 'N/A',
  }))
);

// Calculate overhead
const baseline = bench.tasks.find((t) => t.name === 'baseline: singleton (no scope)');
const withScope = bench.tasks.find((t) => t.name === 'with scope (no override)');
const scopeLocal = bench.tasks.find((t) => t.name === 'scope-local override');
const burstBaseline = bench.tasks.find((t) => t.name === 'burst: 1000 resolutions (baseline)');
const burstWithScope = bench.tasks.find((t) => t.name === 'burst: 1000 resolutions + scope');

if (baseline?.result?.period && withScope?.result?.period) {
  const overhead = ((withScope.result.period - baseline.result.period) * 1000000).toFixed(2);
  const overheadPercent = (
    ((withScope.result.period - baseline.result.period) / baseline.result.period) *
    100
  ).toFixed(2);
  console.log(`\n📊 Scope Check Overhead: ${overhead}ns (${overheadPercent}%)`);
}

if (baseline?.result?.period && scopeLocal?.result?.period) {
  const overhead = ((scopeLocal.result.period - baseline.result.period) * 1000000).toFixed(2);
  const overheadPercent = (
    ((scopeLocal.result.period - baseline.result.period) / baseline.result.period) *
    100
  ).toFixed(2);
  console.log(`📊 Scope-Local Hit Overhead: ${overhead}ns (${overheadPercent}%)`);
}

if (burstBaseline?.result?.period && burstWithScope?.result?.period) {
  const overhead = ((burstWithScope.result.period - burstBaseline.result.period) * 1000000).toFixed(
    0
  );
  const perResolution = (
    (burstWithScope.result.period - burstBaseline.result.period) *
    1000
  ).toFixed(2);
  console.log(`📊 Burst Overhead: ${overhead}ns total, ${perResolution}ns per resolution`);
}

console.log('\n' + '='.repeat(80));
console.log('💡 Analysis:');
console.log('='.repeat(80));
console.log('• Lower is better for all metrics');
console.log('• "with scope (no override)" shows scope check overhead on hot path');
console.log('• "scope-local override" shows fast path when scope-local hit occurs');
console.log('• Overhead < 10ns is negligible for most applications');
console.log('• Overhead > 20ns might need optimization for extreme perf requirements');
console.log('='.repeat(80) + '\n');
