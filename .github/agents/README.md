# Ceryn Development Agents

This directory contains AI agent configurations for specialized roles in the Ceryn project. These agents can be used with AI assistants (like GitHub Copilot, Claude, GPT-4) to provide context-aware assistance for different development tasks.

## Available Agents

### 🏗️ [Architect Agent](./architect-agent.md)

**Role**: System design, architecture decisions, and technical leadership

**Use for**:

- Designing new features and components
- Making architectural decisions
- Planning system structure and module boundaries
- Reviewing design patterns and best practices
- Creating technical specifications

**Example prompt**:

```
@architect-agent I need to add support for lazy loading of dependencies.
How should this be designed to maintain zero-reflection principles?
```

### 👨‍💻 [Developer Agent](./developer-agent.md)

**Role**: Implementation, bug fixes, and code maintenance

**Use for**:

- Implementing new features
- Fixing bugs and issues
- Refactoring existing code
- Writing idiomatic TypeScript
- Following coding standards

**Example prompt**:

```
@developer-agent Implement a new MRU cache eviction policy with configurable size.
Follow the existing patterns in mru-cache.ts.
```

### 🧪 [Tester Agent](./tester-agent.md)

**Role**: Testing, quality assurance, and validation

**Use for**:

- Writing comprehensive tests
- Improving test coverage
- Identifying edge cases
- Performance testing and benchmarking
- Validating behavior

**Example prompt**:

```
@tester-agent Add test cases for the new lazy loading feature.
Cover edge cases, error conditions, and performance benchmarks.
```

### 📦 [Repository Agent](./repo-agent.md)

**Role**: Monorepo management, build systems, and repository health

**Use for**:

- Managing monorepo structure and workspaces
- Coordinating builds and dependencies
- Setting up CI/CD workflows
- Handling package versioning and publishing
- Troubleshooting monorepo issues

**Example prompt**:

```
@repo-agent I want to add a new package for testing utilities.
How should I structure it and integrate it with the existing workspace?
```

## How to Use

### With GitHub Copilot Chat

1. Reference the agent file in your prompt:

   ```
   Using the guidelines from .github/agents/developer-agent.md,
   implement a new token validation function.
   ```

2. Or paste the agent content into your conversation for context.

### With Claude / ChatGPT

1. Attach or paste the relevant agent file at the start of your conversation
2. Ask questions or request tasks within that agent's domain
3. The agent context helps the AI understand project standards and conventions

### Workflow Example

**Starting a new feature:**

1. **Architect Agent**: Design the feature architecture

   ```
   I need to add async vault initialization. Design the API and internal structure.
   ```

2. **Developer Agent**: Implement the design

   ```
   Implement the async vault initialization following the architect's design.
   ```

3. **Tester Agent**: Create comprehensive tests
   ```
   Write unit and integration tests for async vault initialization.
   Cover all edge cases and error scenarios.
   ```

**Fixing a bug:**

1. **Tester Agent**: Reproduce the issue with a test

   ```
   Create a failing test that reproduces the circular dependency bug.
   ```

2. **Developer Agent**: Fix the bug

   ```
   Fix the circular dependency detection logic. Make the test pass.
   ```

3. **Architect Agent**: Review if the fix affects architecture
   ```
   Review the circular dependency fix. Does it maintain our design principles?
   ```

**Adding a new package:**

1. **Repository Agent**: Plan the structure

   ```
   I want to add a @ceryn/testing package. How should I structure it in the monorepo?
   ```

2. **Architect Agent**: Design the package API

   ```
   Design the testing utilities API. What should it expose?
   ```

3. **Developer Agent**: Implement the package
   ```
   Implement the @ceryn/testing package following the monorepo structure.
   ```

## Agent Collaboration

The agents are designed to work together:

```
     Repository ←→ Architect
         ↓              ↓
    (structure)    (designs)
         ↓              ↓
     Developer ──implements──> Tester
         ↑                        ↓
         └────fixes──←──validates─┘
```

- **Repository** manages structure → **Architect** designs within constraints
- **Architect** provides specifications → **Developer** implements → **Tester** validates
- **Tester** identifies issues → **Developer** fixes → **Architect** reviews impact
- **Repository** coordinates builds, dependencies, and releases across all work

## Project-Specific Context

All agents understand the Ceryn monorepo:

- **Structure**: npm workspaces monorepo with `packages/*` pattern
- **Primary Package**: `@ceryn/vault` - Zero-reflection dependency injection
- **Tech Stack**: TypeScript 5.3+, ES modules, Node.js 18+
- **Principles**: Performance-first, type-safe, explicit design
- **Tooling**: Vitest (testing), Tinybench (benchmarks), ESLint, Prettier

### Handling the Monorepo

The repository agent is designed to handle the monorepo structure intelligently:

- **Primary focus** is on `packages/vault` (the main active package)
- **Monorepo context** is understood (shared configs, workspaces, scripts)
- **Future packages** can be added following the established patterns
- **Root-level** coordination for builds, tests, and releases

Since vault is currently the only package, most work happens in `packages/vault/`, but the repo agent can guide you when expanding the monorepo.

## Customization

Each agent file can be customized for your specific needs:

- Add project-specific patterns
- Update coding standards
- Modify testing requirements
- Extend architectural guidelines

## Best Practices

1. **Choose the right agent** for the task
2. **Provide context** about what you're working on
3. **Be specific** in your requests
4. **Iterate** - agents can refine their output based on feedback
5. **Combine agents** for complex tasks

## Contributing

When updating agent files:

- Keep them focused on their specific role
- Update all agents when project patterns change
- Include examples of good and bad practices
- Reference actual code from the project

## Resources

- Root config: `/package.json`, `/tsconfig.base.json`
- Vault package: `/packages/vault/`
- Vault README: `/packages/vault/README.md`
- Source code: `/packages/vault/src/`
- Tests: `/packages/vault/tests/`
- Benchmarks: `/packages/vault/benchmarks/`
