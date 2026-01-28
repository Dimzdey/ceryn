import { Bench } from 'tinybench';
import { Lifecycle, Vault } from '../src/index.js';
import { StaticRelicRegistry } from '../src/static-registry.js';
import { MRUCache } from '../src/vault/mru-cache.js';
import { token } from '../src/vault/token.js';

/**
 * Enormous Benchmark Suite (T1-T5)
 * - Implements the user's requested scenarios in an isolated file
 * - Designed to be run with: npm run bench:enormous (create script if desired)
 */

async function runEnormousBench() {
  console.log('=== Enormous Benchmark Suite (T1-T5) ===');
  console.log(`Node ${process.version} ${process.platform} ${process.arch}`);
  const bench = new Bench({ time: 1000 });

  // ------------------------------------------------------------------
  // T1: Registration Load - 1,000 unique services
  // Measure cost of StaticRelicRegistry.registerRelic and Vault.add
  // ------------------------------------------------------------------
  bench.add('T1.1: StaticRelicRegistry.registerRelic (1000)', () => {
    const ctors: any[] = [];
    for (let i = 0; i < 1000; i++) {
      const C = class {};
      Object.defineProperty(C, 'name', { value: `BenchSvc${i}` });
      ctors.push(C);
    }
    for (let i = 0; i < ctors.length; i++) {
      StaticRelicRegistry.registerRelic(ctors[i] as any, {
        name: `bench:svc:${i}` as any,
        label: `bench:svc:${i}`,
        lifecycle: Lifecycle.Singleton,
      });
    }
  });

  bench.add('T1.2: Vault bootstrap with 1000 relics (EntryStore.add cost)', () => {
    const ctors: any[] = [];
    for (let i = 0; i < 1000; i++) {
      const C = class {};
      Object.defineProperty(C, 'name', { value: `BootSvc${i}` });
      StaticRelicRegistry.registerRelic(C, {
        name: `boot:svc:${i}` as any,
        label: `boot:svc:${i}`,
        lifecycle: Lifecycle.Singleton,
      });
      ctors.push(C);
    }
    new Vault({ name: 'Boot1000', relics: ctors });
  });

  // ------------------------------------------------------------------
  // T2: Deep Dependency Graph - chain resolution
  // Note: Setup (registration + vault creation) is done once outside the
  // measured callback so we only measure the steady-state resolve latency.
  // ------------------------------------------------------------------
  const chainDepths = [10, 25, 50, 100];
  const chainContexts: { depth: number; toks: any[]; vault: Vault }[] = [];

  for (const depth of chainDepths) {
    const toks = new Array(depth).fill(0).map((_, i) => token(`chain:${i}`));
    const ctors: any[] = [];
    for (let i = 0; i < depth; i++) {
      const C = class {};
      Object.defineProperty(C, 'name', { value: `ChainSvc${i}` });
      StaticRelicRegistry.registerRelic(C, {
        name: toks[i].id as any,
        label: toks[i].label,
        lifecycle: Lifecycle.Singleton,
      });
      if (i < depth - 1) {
        // Record constructor parameter dependency to the next token
        StaticRelicRegistry.registerSummon(C, 0, toks[i + 1]);
      }
      ctors.push(C);
    }
    const v = new Vault({ name: `Chain:${depth}`, relics: ctors });
    // warm the chain once so singleton instantiation (if any) happens before measurement
    try {
      v.resolve(toks[0]);
    } catch (e) {
      // ignore instantiation errors during warm-up
    }
    chainContexts.push({ depth, toks, vault: v });
  }

  for (const ctx of chainContexts) {
    bench.add(`T2: Deep chain depth=${ctx.depth}`, () => {
      ctx.vault.resolve(ctx.toks[0]);
    });
  }

  // ------------------------------------------------------------------
  // T3: High-Frequency Local Hit - 10 services × 1_000_000 resolves
  // Setup and measurement are separated: setup is done once here so the
  // bench task only measures the tight resolve loop. Diagnostics run as a
  // separate task that enables instrumentation (and is therefore kept
  // isolated from the critical-path measurement).
  // ------------------------------------------------------------------
  const hotToks = new Array(10).fill(0).map((_, i) => token(`hot:${i}`));
  const hotCtors: any[] = [];
  for (let i = 0; i < 10; i++) {
    const C = class {
      value = i;
    };
    Object.defineProperty(C, 'name', { value: `HotSvc${i}` });
    StaticRelicRegistry.registerRelic(C, {
      name: hotToks[i].id as any,
      label: hotToks[i].label,
      lifecycle: Lifecycle.Singleton,
    });
    hotCtors.push(C);
  }

  const hotVault = new Vault({ name: 'HotVault', relics: hotCtors });
  // Warm singletons once (outside measured loop)
  for (let i = 0; i < hotToks.length; i++) hotVault.resolve(hotToks[i]);

  const HOT_N = 1_000_000;
  bench.add('T3: Hot local resolves (10 services × 1_000_000) - measure', () => {
    for (let i = 0; i < HOT_N; i++) {
      const t = hotToks[i % hotToks.length];
      const inst = hotVault.resolve(t);
      if (!inst) throw new Error('unreachable');
    }
  });

  // Separate diagnostics pass: wrap MRUCache.get, run a smaller sample, restore
  bench.add('T3: MRU diagnostics (instrumented, separate pass)', () => {
    const originalGet = MRUCache.prototype.get;
    let mruHits = 0;
    let mruCalls = 0;
    (MRUCache.prototype as any).get = function (token: string) {
      mruCalls++;
      const res = originalGet.call(this, token);
      if (res) mruHits++;
      return res;
    };

    // Smaller diagnostic sample to avoid extremely long instrumented runs
    const D = 100_000;
    for (let i = 0; i < D; i++) {
      const t = hotToks[i % hotToks.length];
      hotVault.resolve(t);
    }

    (MRUCache.prototype as any).get = originalGet;
    const hitRate = mruCalls === 0 ? 0 : (mruHits / mruCalls) * 100;
    console.log(
      '\n[T3 diagnostics] MRU calls=',
      mruCalls,
      'hits=',
      mruHits,
      'hitRate=',
      hitRate.toFixed(2) + '%'
    );
  });

  // ------------------------------------------------------------------
  // T4: Broad Aether Crossing - 10 peers fused to a host; host resolves 50 services
  // ------------------------------------------------------------------
  bench.add('T4: Broad Aether Crossing (10 peers -> host resolves 50)', () => {
    const peerCount = 10;
    const perPeer = 4; // 10 * 4 = 40 exposed services
    const peers: Vault[] = [];
    const exposedTokens: any[] = [];

    for (let p = 0; p < peerCount; p++) {
      const rels: any[] = [];
      const reveal: any[] = [];
      for (let j = 0; j < perPeer; j++) {
        const t = token(`peer:${p}:svc:${j}`);
        exposedTokens.push(t);
        const C = class {
          id = p * perPeer + j;
        };
        Object.defineProperty(C, 'name', { value: `Peer${p}Svc${j}` });
        StaticRelicRegistry.registerRelic(C, {
          name: t.id as any,
          label: t.label,
          lifecycle: Lifecycle.Singleton,
        });
        rels.push(C);
        reveal.push(t.id as any);
      }
      // Create peer vault exposing its tokens (aether host)
      peers.push(new Vault({ name: `Peer${p}`, relics: rels, reveal, aether: true }));
    }

    // Host local relics (10)
    const hostCtors: any[] = [];
    const hostTokens: any[] = [];
    for (let i = 0; i < 10; i++) {
      const t = token(`host:local:${i}`);
      const C = class {
        i = i;
      };
      Object.defineProperty(C, 'name', { value: `HostLocal${i}` });
      StaticRelicRegistry.registerRelic(C, {
        name: t.id as any,
        label: t.label,
        lifecycle: Lifecycle.Singleton,
      });
      hostCtors.push(C);
      hostTokens.push(t);
    }

    const host = new Vault({ name: 'Host', fuse: peers, relics: hostCtors });

    // Resolve 50 tokens: first 40 from peers (exposed) then 10 local
    const tokensToResolve: any[] = [...exposedTokens.slice(0, 40), ...hostTokens];
    for (let r = 0; r < 200; r++) {
      for (let i = 0; i < tokensToResolve.length; i++) {
        try {
          host.resolve(tokensToResolve[i]);
        } catch (e) {
          // swallow to avoid bench crash
        }
      }
    }
  });

  // ------------------------------------------------------------------
  // T5: Aether Depth Crossing - 5 vaults chained and host resolves service from deepest
  // ------------------------------------------------------------------
  bench.add('T5: Aether Depth Crossing (chain depth=5)', () => {
    const depth = 5;
    const vaults: Vault[] = [];
    const toks: any[] = [];
    for (let i = 0; i < depth; i++) {
      const t = token(`depth:${i}:svc`);
      toks.push(t);
      const C = class {};
      Object.defineProperty(C, 'name', { value: `DepthSvc${i}` });
      StaticRelicRegistry.registerRelic(C, {
        name: t.id as any,
        label: t.label,
        lifecycle: Lifecycle.Singleton,
      });
      // each vault reveals its token to aether
      vaults.push(
        new Vault({
          name: `Depth${i}`,
          relics: [C],
          reveal: [t.id as any],
          aether: true,
        })
      );
    }

    // Chain them so the head can reach all deeper vaults.
    // Correct chaining (transitive fusion): start with the first vault as
    // the initial head and iteratively fuse the next vault to the head.
    // This builds: head0 (vaults[0]) -> head1 (fuse head0 + vaults[1]) -> ...
    let head: Vault = vaults[0];
    for (let i = 1; i < vaults.length; i++) {
      head = new Vault({ name: `ChainHead${i}`, fuse: [head, vaults[i]], relics: [] });
    }

    // Resolve from the head the service located in the deepest vault
    head.resolve(toks[toks.length - 1]);
  });

  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks`);
  await bench.run();

  console.table(bench.table());
}

runEnormousBench().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
