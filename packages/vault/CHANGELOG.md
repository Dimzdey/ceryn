## @ceryn/vault-v2.4.0 (2026-06-12)

* feat(vault): expose legacy aliases via compat subpath ([8d9d437](https://github.com/Dimzdey/ceryn/commit/8d9d437))
* feat(vault): expose test isolation reset hooks ([9795288](https://github.com/Dimzdey/ceryn/commit/9795288))
* docs(vault): update package and benchmark docs ([b62836f](https://github.com/Dimzdey/ceryn/commit/b62836f))
* fix(vault): isolate async resolution stacks ([875fbb0](https://github.com/Dimzdey/ceryn/commit/875fbb0))
* fix(vault): refresh error guidance ([472c537](https://github.com/Dimzdey/ceryn/commit/472c537))
* fix(vault): reject invalid lifecycle values ([df7dabc](https://github.com/Dimzdey/ceryn/commit/df7dabc))
* fix(vault): reject resolution during disposal ([42fbf72](https://github.com/Dimzdey/ceryn/commit/42fbf72))

## @ceryn/vault-v2.3.1 (2026-06-12)

* fix(vault): cross-vault edge cases ([c76ebba](https://github.com/Dimzdey/ceryn/commit/c76ebba))

## @ceryn/vault-v2.3.0 (2026-06-12)

* feat(vault): implement instance ownership tracking and ambiguous import detection ([ea96296](https://github.com/Dimzdey/ceryn/commit/ea96296))
* fix(vault): split has and canResolve ([7761c6d](https://github.com/Dimzdey/ceryn/commit/7761c6d))
* fix(vault): validate providers ([f35218a](https://github.com/Dimzdey/ceryn/commit/f35218a))

## @ceryn/vault-v2.2.3 (2026-06-12)

* fix(vault): split has and canResolve ([21b5a43](https://github.com/Dimzdey/ceryn/commit/21b5a43))

## @ceryn/vault-v2.2.2 (2026-06-12)

* fix(vault): enforce strict validation ([5ea5079](https://github.com/Dimzdey/ceryn/commit/5ea5079))

## @ceryn/vault-v2.2.1 (2026-06-11)

* fix(vault): enforce module lifecycle rules ([1616723](https://github.com/Dimzdey/ceryn/commit/1616723))
* chore(ci): add semantic-release-monorepo for path-based vault releases ([66b6f1b](https://github.com/Dimzdey/ceryn/commit/66b6f1b))
* chore(ci): fix releaseRules - remove invalid wildcard ([5c52f9c](https://github.com/Dimzdey/ceryn/commit/5c52f9c))
* chore(ci): make vault release rules airtight against non-vault commits ([cd82ccb](https://github.com/Dimzdey/ceryn/commit/cd82ccb))
* chore(ci): scope vault releases to vault-only commits ([2b8e560](https://github.com/Dimzdey/ceryn/commit/2b8e560))

## 2.2.0 (2026-06-10)

* fix(ci): ensure vault builds before fastify typecheck in CI ([13bb0f5](https://github.com/Dimzdey/ceryn/commit/13bb0f5))
* feat(repo): add @ceryn/fastify adapter with per-request scoped DI ([64eca65](https://github.com/Dimzdey/ceryn/commit/64eca65))
* feat(repo): add @ceryn/fastify adapter with per-request scoped DI ([8de3ac8](https://github.com/Dimzdey/ceryn/commit/8de3ac8))
* chore(deps): update package-lock for fastify adapter ([0b71582](https://github.com/Dimzdey/ceryn/commit/0b71582))

## <small>2.1.2 (2026-06-10)</small>

* fix(vault): update benchmark table with optimized scoped results ([a053fd2](https://github.com/Dimzdey/ceryn/commit/a053fd2))
* perf(vault): optimize scoped lifecycle hot path ([580e2ac](https://github.com/Dimzdey/ceryn/commit/580e2ac))

## <small>2.1.1 (2026-06-10)</small>

* fix(vault): update package metadata for npm registry ([591fb58](https://github.com/Dimzdey/ceryn/commit/591fb58))
* docs(vault): fix benchmark summary for N/A adapters, document scoped trade-off ([45cfc9d](https://github.com/Dimzdey/ceryn/commit/45cfc9d))
* docs(vault): update README to v2.0.0 API terminology ([55e96de](https://github.com/Dimzdey/ceryn/commit/55e96de))

## 2.1.0 (2026-06-10)

* feat(vault): add scoped lifecycle and async factory benchmark phases ([f6e0ec9](https://github.com/Dimzdey/ceryn/commit/f6e0ec9))

## 2.0.0 (2026-06-10)

* chore: add docs/ to gitignore ([16b4e48](https://github.com/Dimzdey/ceryn/commit/16b4e48))
* chore(vault): bump version to 2.0.0 ([4dfe178](https://github.com/Dimzdey/ceryn/commit/4dfe178))
* feat(vault): v2.0.0 — fix all issues, rename API to standard DI terminology, consolidate benchmarks ([631fa79](https://github.com/Dimzdey/ceryn/commit/631fa79))
* feat(vault)!: rename API to standard DI terminology (BREAKING) ([bca8198](https://github.com/Dimzdey/ceryn/commit/bca8198))
* docs(vault): add benchmark results table to README ([0e39fc4](https://github.com/Dimzdey/ceryn/commit/0e39fc4))
* docs(vault): fix README performance claims, add abort listener lifecycle comment ([b203d55](https://github.com/Dimzdey/ceryn/commit/b203d55))
* refactor(vault): consolidate benchmarks into single representative comparison ([8328177](https://github.com/Dimzdey/ceryn/commit/8328177))
* refactor(vault): rename MRUCache to SingletonCache, remove unused mruSize config ([afbc916](https://github.com/Dimzdey/ceryn/commit/afbc916))
* test(vault): add ESM smoke test to catch packaging regressions ([45d06eb](https://github.com/Dimzdey/ceryn/commit/45d06eb))
* fix(vault): always freeze Relic metadata, remove misleading beginScope, validate config ([7e164b3](https://github.com/Dimzdey/ceryn/commit/7e164b3))
* fix(vault): change scope disposer order from FIFO to documented LIFO ([558ba3b](https://github.com/Dimzdey/ceryn/commit/558ba3b))
* fix(vault): eliminate shared scratchStack re-entrancy hazard in sync resolve ([439be4e](https://github.com/Dimzdey/ceryn/commit/439be4e))
* fix(vault): export all error classes from public API ([7f5df9d](https://github.com/Dimzdey/ceryn/commit/7f5df9d))
* fix(vault): remove broken ./testing export and dead benchmark scripts ([0b3ef02](https://github.com/Dimzdey/ceryn/commit/0b3ef02))
* fix(vault): remove unimplemented manifest types, delete dead AliasCollisionError, fix doc drift ([1d5075b](https://github.com/Dimzdey/ceryn/commit/1d5075b))
* fix(vault): switch to NodeNext module resolution and fix all import extensions ([d383bae](https://github.com/Dimzdey/ceryn/commit/d383bae))
* fix(vault): throw VaultDisposedError when resolving from disposed vault ([c64254c](https://github.com/Dimzdey/ceryn/commit/c64254c))
* fix(vault): wire lifecycle validation at resolution time for order-independent checking ([d71a5ad](https://github.com/Dimzdey/ceryn/commit/d71a5ad))
* fix(vault): wire shadow-policy enforcement at vault construction ([aeec30f](https://github.com/Dimzdey/ceryn/commit/aeec30f))


### BREAKING CHANGE

* All public API symbols renamed to standard DI terminology.

## 1.1.0 (2026-02-02)

* feat(vault): add createTokenGroup utility for organizing tokens (#2) ([27160da](https://github.com/Dimzdey/ceryn/commit/27160da)), closes [#2](https://github.com/Dimzdey/ceryn/issues/2)
* Potential fix for code scanning alert no. 1: Workflow does not contain permissions (#1) ([a87d995](https://github.com/Dimzdey/ceryn/commit/a87d995)), closes [#1](https://github.com/Dimzdey/ceryn/issues/1)

## <small>1.0.3 (2026-01-28)</small>

* fix(vault): ensure automated publishing works correctly ([a644b50](https://github.com/Dimzdey/ceryn/commit/a644b50))
* chore(ci): trigger 1.0.3 release after fixing public access ([8f6fd26](https://github.com/Dimzdey/ceryn/commit/8f6fd26))

## <small>1.0.2 (2026-01-28)</small>

* fix(vault): add publishConfig for public npm access ([67f4703](https://github.com/Dimzdey/ceryn/commit/67f4703))

## <small>1.0.1 (2026-01-28)</small>

* fix(ci): configure npm publish with public access ([2b8ffc5](https://github.com/Dimzdey/ceryn/commit/2b8ffc5))

## 1.0.0 (2026-01-28)

* feat: automate publishing via tag push instead of manual release creation ([76405a8](https://github.com/Dimzdey/ceryn/commit/76405a8))
* feat: initial commit with vault package and agent configurations ([0cc060f](https://github.com/Dimzdey/ceryn/commit/0cc060f))
* feat(repo): add fully automated versioning with semantic-release ([4794b1a](https://github.com/Dimzdey/ceryn/commit/4794b1a))
* feat(vault): first release with automated publishing ([94b1dfe](https://github.com/Dimzdey/ceryn/commit/94b1dfe))
* chore: add automated npm publishing workflow and publishing guide ([a089705](https://github.com/Dimzdey/ceryn/commit/a089705))
* chore: add package-lock.json for reproducible builds ([1c37a71](https://github.com/Dimzdey/ceryn/commit/1c37a71))
* chore: add pre-commit hooks with husky and lint-staged ([5dc022a](https://github.com/Dimzdey/ceryn/commit/5dc022a))
* chore(ci): trigger release after npm token update ([4d7114a](https://github.com/Dimzdey/ceryn/commit/4d7114a))
* chore(release): 1.0.0 [skip ci] ([18ea97d](https://github.com/Dimzdey/ceryn/commit/18ea97d))
* chore(vault): reset version for proper semantic-release automation ([a2c79cb](https://github.com/Dimzdey/ceryn/commit/a2c79cb))
* fix: update lint-staged glob pattern for monorepo structure ([2a614b5](https://github.com/Dimzdey/ceryn/commit/2a614b5))
* fix(ci): add release scope to commitlint for semantic-release ([aa13340](https://github.com/Dimzdey/ceryn/commit/aa13340))
* fix(ci): remove npm cache to work without package-lock.json ([a5a6a53](https://github.com/Dimzdey/ceryn/commit/a5a6a53))
* fix(ci): use correct test script and optimize pre-commit hooks ([6cf9e23](https://github.com/Dimzdey/ceryn/commit/6cf9e23))
* fix(ci): use Node.js 22 for semantic-release compatibility ([c00ac9b](https://github.com/Dimzdey/ceryn/commit/c00ac9b))

## 1.0.0 (2026-01-28)

* fix: update lint-staged glob pattern for monorepo structure ([2a614b5](https://github.com/Dimzdey/ceryn/commit/2a614b5))
* fix(ci): add release scope to commitlint for semantic-release ([aa13340](https://github.com/Dimzdey/ceryn/commit/aa13340))
* fix(ci): remove npm cache to work without package-lock.json ([a5a6a53](https://github.com/Dimzdey/ceryn/commit/a5a6a53))
* fix(ci): use correct test script and optimize pre-commit hooks ([6cf9e23](https://github.com/Dimzdey/ceryn/commit/6cf9e23))
* fix(ci): use Node.js 22 for semantic-release compatibility ([c00ac9b](https://github.com/Dimzdey/ceryn/commit/c00ac9b))
* feat: automate publishing via tag push instead of manual release creation ([76405a8](https://github.com/Dimzdey/ceryn/commit/76405a8))
* feat: initial commit with vault package and agent configurations ([0cc060f](https://github.com/Dimzdey/ceryn/commit/0cc060f))
* feat(repo): add fully automated versioning with semantic-release ([4794b1a](https://github.com/Dimzdey/ceryn/commit/4794b1a))
* chore: add automated npm publishing workflow and publishing guide ([a089705](https://github.com/Dimzdey/ceryn/commit/a089705))
* chore: add package-lock.json for reproducible builds ([1c37a71](https://github.com/Dimzdey/ceryn/commit/1c37a71))
* chore: add pre-commit hooks with husky and lint-staged ([5dc022a](https://github.com/Dimzdey/ceryn/commit/5dc022a))
