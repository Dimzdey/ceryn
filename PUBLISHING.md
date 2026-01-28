# Publishing Guide

This guide explains how to publish packages from the Ceryn monorepo to npm.

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

## Publishing Methods

### Method 1: GitHub Release (Recommended)

This automatically publishes when you create a release:

1. **Update version in package.json**

   ```bash
   cd packages/vault
   npm version patch  # or minor, major
   ```

2. **Commit and push**

   ```bash
   git add .
   git commit -m "chore(vault): bump version to 0.1.1"
   git push
   ```

3. **Create GitHub Release**
   - Go to: https://github.com/Dimzdey/ceryn/releases/new
   - Tag: `vault-v0.1.1` (must match package version)
   - Title: `@ceryn/vault v0.1.1`
   - Description: Add release notes
   - Click **Publish release**

4. **Automatic Publishing**
   - GitHub Actions will automatically:
     - Run all tests
     - Build the package
     - Publish to npm
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