# Publishing Guide

This guide explains how to publish packages from the Ceryn monorepo to npm using **automated semantic versioning**.

## How It Works

🚀 **Fully Automated**: Versioning, changelogs, and publishing happen automatically based on your commit messages.

### Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types & Version Bumps:**

- `feat:` → Minor version (0.1.0 → 0.2.0) - New features
- `fix:` → Patch version (0.1.0 → 0.1.1) - Bug fixes
- `perf:` → Patch version - Performance improvements
- `BREAKING CHANGE:` → Major version (0.1.0 → 1.0.0) - Breaking changes
- `docs:`, `chore:`, `style:`, `refactor:`, `test:` → No release

**Examples:**

```bash
# Patch release (0.1.0 → 0.1.1)
git commit -m "fix(vault): resolve circular dependency issue"

# Minor release (0.1.0 → 0.2.0)
git commit -m "feat(vault): add async dependency resolution"

# Major release (0.1.0 → 1.0.0)
git commit -m "feat(vault): redesign API

BREAKING CHANGE: The excavate() method now returns a Promise"

# No release
git commit -m "docs(vault): update README examples"
```

## Publishing Process

### Automatic Publishing (Recommended)

Just push to main with conventional commits:

```bash
# 1. Make your changes
git add .
git commit -m "feat(vault): add lazy loading support"

# 2. Push to main
git push

# 3. Done! Semantic-release automatically:
#    ✅ Analyzes commits
#    ✅ Determines version bump
#    ✅ Updates package.json
#    ✅ Generates CHANGELOG.md
#    ✅ Creates git tag
#    ✅ Publishes to npm
#    ✅ Creates GitHub release
```

Watch progress: https://github.com/Dimzdey/ceryn/actions

### What Gets Released?

Semantic-release only creates a release if there are relevant commits since the last release:

- Has `feat:` or `fix:` commits → **Release happens**
- Only `docs:`, `chore:`, etc. → **No release**
- No commits → **No release**

## Setup (One-time)

### 1. Create npm Access Token

1. Go to [npmjs.com](https://www.npmjs.com) and log in
2. Click your profile → **Access Tokens** → **Generate New Token**
3. Choose **Automation** (for CI/CD publishing)
4. Copy the token

### 2. Add Token to GitHub Secrets

1. Go to your repo: https://github.com/Dimzdey/ceryn
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `NPM_TOKEN`
5. Value: Paste your npm token
6. Click **Add secret**

### What Gets Released?

Semantic-release only creates a release if there are relevant commits since the last release:

- Has `feat:` or `fix:` commits → **Release happens**
- Only `docs:`, `chore:`, etc. → **No release**
- No commits → **No release**

## First Release

For the initial v0.1.0 release, commit with:

```bash
git commit --allow-empty -m "feat(vault): initial release"
git push
```

This will trigger semantic-release to publish v0.1.0 (or v1.0.0 if you prefer).

## Commit Message Validation

Commit messages are automatically validated on commit. If invalid, you'll see:

```
⧗   input: chore add stuff
✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]
```

Fix it with proper format:

```bash
git commit -m "chore(vault): add stuff"
```

## Manual Publishing (Emergency Only)

This is the simplest way - just push a version tag:

1. **Update version and create tag**

   ```bash
   cd packages/vault
   npm version patch  # or minor, major
   # This updates package.json AND creates a git tag
   ```

2. **Push everything**

   ```bash
   git push && git push --tags
   ```

3. **Done!**
   - GitHub Actions automatically detects the tag
   - Runs all tests and checks
   - Publishes to npm
   - Creates a GitHub release
   - Check progress: https://github.com/Dimzdey/ceryn/actions

### Method 2: Manual Workflow Trigger

Publish without creating a release:

1. Go to: https://github.com/Dimzdey/ceryn/actions/workflows/publish.yml
2. Click **Run workflow**
3. Select **vault**
4. Click **Run workflow**

This will publish the current version and create a release automatically.

### Method 3: Local Publishing (Not Recommended)

If you need to publish manually:

```bash
cd packages/vault

# 1. Login to npm (one-time)
npm login

# 2. Run full check
cd ../..
npm run check
npm run test
npm run build

# 3. Publish
cd packages/vault
npm publish --access public
```

## Version Naming Convention

Use semantic versioning:

- **patch** (0.1.0 → 0.1.1): Bug fixes
- **minor** (0.1.0 → 0.2.0): New features (backward compatible)
- **major** (0.1.0 → 1.0.0): Breaking changes

## Release Tag Format

For monorepo packages, use: `<package>-v<version>`

Examples:

- `vault-v0.1.0`
- `vault-v0.2.0`
- `vault-v1.0.0`

## Pre-release Versions

For beta/alpha releases:

```bash
npm version prerelease --preid=beta  # 0.1.0 → 0.1.1-beta.0
npm version prerelease --preid=alpha # 0.1.0 → 0.1.1-alpha.0
```

Tag format: `vault-v0.1.1-beta.0`

## Checklist Before Publishing

- [ ] All tests pass: `npm run test`
- [ ] No lint errors: `npm run lint`
- [ ] Code formatted: `npm run format:check`
- [ ] Types check: `npm run typecheck`
- [ ] CHANGELOG updated
- [ ] Version bumped in package.json
- [ ] README accurate
- [ ] No uncommitted changes
- [ ] Pushed to GitHub

## Troubleshooting

### "NPM_TOKEN not found"

- Ensure you added the token to GitHub Secrets
- Name must be exactly `NPM_TOKEN`

### "Package already published"

- Version in package.json must be incremented
- Check current version: https://www.npmjs.com/package/@ceryn/vault

### "Permission denied"

- Ensure your npm account has publish rights to @ceryn scope
- For first publish, use `npm publish --access public`

### Workflow fails on tests

- Check the Actions log for details
- Fix issues locally and push again

## Automated Workflow Behavior

The publish workflow will:

1. ✅ Checkout code
2. ✅ Install dependencies
3. ✅ Run type checking
4. ✅ Run linting
5. ✅ Run format check
6. ✅ Run all tests
7. ✅ Build packages
8. ✅ Publish to npm with provenance
9. ✅ Create/update GitHub release

## Future: Multiple Packages

When you add more packages:

- Use tags like `testing-v0.1.0`, `benchmarks-v0.1.0`
- The workflow automatically detects which package to publish from the tag

## Resources

- npm package: https://www.npmjs.com/package/@ceryn/vault
- GitHub releases: https://github.com/Dimzdey/ceryn/releases
- GitHub Actions: https://github.com/Dimzdey/ceryn/actions
