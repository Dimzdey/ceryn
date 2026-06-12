# Benchmark Methodology

Benchmarks compare basic dependency-resolution scenarios across Ceryn Vault and selected DI containers.

Run:

```bash
npm run bench -w packages/vault
```

Record with each result:

- Node.js version: `node --version`
- CPU model and core count
- OS and architecture
- package lockfile revision
- benchmark command
- warmup policy reported by Tinybench
- iteration count and variance

Interpretation rules:

- Treat results as local measurements, not universal rankings.
- Compare within the same machine and dependency lockfile only.
- Do not publish a headline multiplier unless raw results, variance, and environment are included.
