/**
 * Global type declarations for Ceryn runtime features.
 */

/**
 * Vault manifest interface for pre-analyzed DI structure.
 * Generated at build time by @ceryn/compiler.
 */
export interface VaultManifest {
  version: string;
  root: string;
  vaults: Record<string, VaultMetadata>;
  relics: Record<string, RelicMetadata>;
  tokens: Record<string, TokenMetadata>;
}

export interface VaultMetadata {
  name: string;
  relics: string[];
  reveal: string[];
  fuse: string[];
  aether: boolean;
}

export interface RelicMetadata {
  name: string;
  token: string;
  deps: string[];
  lifecycle: 'singleton' | 'transient' | 'scoped';
}

export interface TokenMetadata {
  id: string;
  label: string;
}

declare global {
  /**
   * Injected vault manifest for fast cold-start bootstrapping.
   * Set by @ceryn/compiler build plugins at build time.
   *
   * When present, Genesis.from() automatically uses the manifest
   * instead of scanning decorators, reducing cold start time by ~10x.
   */
  var __CERYN_MANIFEST__: VaultManifest | undefined;
}

export {};
