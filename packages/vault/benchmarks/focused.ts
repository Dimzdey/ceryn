import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

import { Bench } from 'tinybench';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Lifecycle } from '../src/types/types.js';

const Depth = 30;
const Chain = Array.from({ length: Depth }, (_, index) => token<{ n: number }>(`Focused${index}`));
const Scoped = token<{ n: number }>('FocusedScoped');
const Request = token<number>('FocusedRequest');
const AsyncValue = token<object>('FocusedAsync');

function buildVault(): Vault {
  const providers: Array<Record<string, unknown>> = [{ provide: Chain[0], useValue: { n: 0 } }];
  for (let index = 1; index < Chain.length; index++) {
    providers.push({
      provide: Chain[index],
      deps: [Chain[index - 1]],
      useFactory: (dependency: unknown) => ({ n: (dependency as { n: number }).n + 1 }),
    });
  }
  providers.push(
    {
      provide: Scoped,
      lifecycle: Lifecycle.Scoped,
      deps: [Request],
      useFactory: (request: unknown) => ({ n: request as number }),
    },
    { provide: AsyncValue, useFactory: async () => ({}) }
  );
  return new Vault({ providers: providers as never });
}

const vault = buildVault();
const hotScope = vault.createScope();
hotScope.resolve(Chain.at(-1)!);
await vault.resolveAsync(AsyncValue);

const time = Number.parseInt(process.env.BENCH_TIME_MS ?? '300', 10);
const warmupTime = Number.parseInt(process.env.BENCH_WARMUP_MS ?? '75', 10);
const seed = Number.parseInt(process.env.BENCH_SEED ?? '42', 10) >>> 0;
const bench = new Bench({ time, warmupTime });

bench.add('cached resolve 1k', () => {
  for (let index = 0; index < 1_000; index++) hotScope.resolve(Chain.at(-1)!);
});
bench.add('cached tryResolve 1k', () => {
  for (let index = 0; index < 1_000; index++) hotScope.tryResolve(Chain.at(-1)!);
});
bench.add('canResolve + resolve 1k', () => {
  for (let index = 0; index < 1_000; index++) {
    if (vault.canResolve(Chain.at(-1)!)) vault.resolve(Chain.at(-1)!);
  }
});
bench.add('scoped cycle 1k', () => {
  for (let index = 0; index < 1_000; index++) {
    const scope = vault.createScope();
    scope.provide(Request, index);
    void scope.resolve(Scoped).n;
    scope.disposeSync();
  }
});
bench.add('metadata + build 100', () => {
  for (let index = 0; index < 100; index++) void buildVault();
});
bench.add('bound scope async cached 100', async () => {
  for (let index = 0; index < 100; index++) await hotScope.resolveAsync(AsyncValue);
});
bench.add('root async cached 100', async () => {
  for (let index = 0; index < 100; index++) await vault.resolveAsync(AsyncValue);
});

await bench.run();
const tasks = bench.tasks.map((task) => ({
  name: task.name,
  samplesNs: task.result?.latency.samples.map((sampleMs) => sampleMs * 1_000_000) ?? [],
}));
const output = {
  suite: 'vault-focused',
  seed,
  environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown' },
  tasks,
};
console.table(bench.table());
if (process.env.BENCH_OUTPUT_JSON) {
  writeFileSync(resolve(process.env.BENCH_OUTPUT_JSON), `${JSON.stringify(output, null, 2)}\n`);
}
