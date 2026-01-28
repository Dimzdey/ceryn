const IS_PROD = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';

const join = (lines: string[]): string => lines.join('\n');
const format = (prod: string, devLines: string[]): string => (IS_PROD ? prod : join(devLines));

/**
 * Circular dependency detected error
 */
export class CircularDependencyError extends Error {
  constructor(public cycle: string[]) {
    const cycleStr = cycle.join(' → ');
    const message = format(`Circular dependency detected: ${cycleStr}`, [
      'Circular dependency detected:',
      '',
      `  ${cycleStr}`,
      '',
      `This means ${cycle[cycle.length - 1]} depends on itself through other services.`,
      '',
      'Common causes:',
      `  1. Constructor injection creates a cycle`,
      `  2. Services that should be split (SRP violation)`,
      '',
      'Solutions:',
      `  1. Extract shared logic into a separate service`,
      `  2. Use events/message bus instead of direct dependencies`,
      `  3. Reconsider if you need dependency injection here`,
    ]);
    super(message);
    this.name = 'CircularDependencyError';
  }
}

/**
 * Relic not found error with helpful suggestions
 */
export class RelicNotFoundError extends Error {
  constructor(
    public token: string,
    public availableRelics: string[],
    public dependencyChain?: string[]
  ) {
    const parts: string[] = [`Cannot resolve relic '${token}'.`, ''];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${token}`, '');
    }

    if (availableRelics.length > 0 && availableRelics.length <= 10) {
      parts.push('Available relics:');
      availableRelics.forEach((r) => parts.push(`  - ${r}`));
      parts.push('');
    } else if (availableRelics.length > 10) {
      parts.push(`\n${availableRelics.length} relics are registered.`);
    }

    parts.push('To fix this:');
    parts.push(`  1. Add @Relic() decorator to ${token}`);
    parts.push(`  2. Include it in the 'relics' array when constructing the vault`);
    parts.push(`  3. Check for typos in @Summon('${token}') or provider tokens`, '');

    super(format(`Cannot resolve relic '${token}'.`, parts));
    this.name = 'RelicNotFoundError';
  }
}

export class MissingSummonDecoratorError extends Error {
  constructor(
    public className: string,
    public parameterIndex: number
  ) {
    const dev = [
      'Missing @Summon decorator',
      '',
      `Parameter ${parameterIndex} of ${className} is missing a @Summon decorator.`,
      '',
      'Fix:',
      `  - Add @Summon(SomeService) to the constructor parameter at index ${parameterIndex}`,
      '',
      'Example:',
      `  @Relic()`,
      `  class ${className} {`,
      `    constructor(`,
      `      @Summon(SomeService) private service: SomeService`,
      `    ) {}`,
      `  }`,
    ];
    super(format(`Missing @Summon decorator at parameter ${parameterIndex} of ${className}.`, dev));
    this.name = 'MissingSummonDecoratorError';
  }
}

export class RelicNotExposedError extends Error {
  constructor(
    public token: string,
    public vaultName: string,
    public revealedRelics: string[]
  ) {
    const dev = [
      `Relic '${token}' is not revealed by vault '${vaultName}'.`,
      '',
      `This relic exists in '${vaultName}' but was not included in the 'reveal' list.`,
      `Only revealed relics can be accessed from fused vaults.`,
      '',
      ...(revealedRelics.length > 0
        ? ['Revealed relics:', ...revealedRelics.map((r) => `  - ${r}`)]
        : [`Vault '${vaultName}' does not reveal any relics.`]),
      '',
      'To fix this:',
      `  1. Add '${token}' to the 'reveal' array in vault '${vaultName}'`,
      `  2. Or register '${token}' directly in the current vault`,
    ];
    super(format(`Relic '${token}' is not revealed by vault '${vaultName}'.`, dev));
    this.name = 'RelicNotExposedError';
  }
}

export class CircularVaultAttachmentError extends Error {
  constructor(public cycle: string[]) {
    const cycleStr = cycle.join(' → ');
    const dev = [
      'Circular vault fusion detected:',
      '',
      `  ${cycleStr}`,
      '',
      'Vaults cannot fuse to each other in a circular manner.',
      '',
      'To fix this:',
      `  1. Reorganize vault hierarchy to be tree-shaped (no cycles)`,
      `  2. Extract shared relics into a separate base vault`,
      `  3. Have both vaults fuse to the base vault instead`,
    ];
    super(format(`Circular vault fusion detected: ${cycleStr}`, dev));
    this.name = 'CircularVaultAttachmentError';
  }
}

export class InvalidProviderError extends Error {
  constructor(public provider: unknown) {
    let providerString: string;
    try {
      providerString = JSON.stringify(provider, null, 2);
    } catch {
      providerString = String(provider);
    }

    const dev = [
      'Invalid provider configuration',
      '',
      'Valid provider shapes:',
      `  - A class constructor decorated with @Relic()`,
      `  - An object with 'provide' and 'useClass'`,
      `  - An object with 'provide' and 'useValue'`,
      `  - An object with 'provide' and 'useFactory'`,
      '',
      'Received:',
      providerString,
    ];

    super(format('Invalid provider configuration.', dev));
    this.name = 'InvalidProviderError';
  }
}

export class TokenCollisionError extends Error {
  constructor(
    public token: string,
    public existingOwner: string,
    public newOwner: string
  ) {
    const dev = [
      'Token collision',
      '',
      `Token '${token}' is already registered in vault '${existingOwner}', cannot re-register in '${newOwner}'.`,
    ];
    super(format(`Token '${token}' already registered in '${existingOwner}'.`, dev));
    this.name = 'TokenCollisionError';
  }
}

export class AliasCollisionError extends Error {
  constructor(
    public alias: string,
    public mappedTo: string,
    public attemptedFor: string,
    public vaultName: string
  ) {
    const dev = [
      'Alias collision',
      '',
      `Alias '${alias}' in vault '${vaultName}' maps to '${mappedTo}', cannot remap to '${attemptedFor}'.`,
    ];
    super(format(`Alias '${alias}' already maps to '${mappedTo}' in vault '${vaultName}'.`, dev));
    this.name = 'AliasCollisionError';
  }
}

export class MissingRelicDecoratorError extends Error {
  constructor(public ctorName: string) {
    const dev = [
      'Missing @Relic decorator',
      '',
      `Class ${ctorName} is not decorated with @Relic().`,
      `Decorate it with @Relic() or register it via an explicit provider.`,
    ];
    super(format(`Class ${ctorName} must be decorated with @Relic().`, dev));
    this.name = 'MissingRelicDecoratorError';
  }
}

export class UnconstructableRelicError extends Error {
  constructor(public token: string) {
    const dev = [
      'Unconstructable relic',
      '',
      `Relic '${token}' has neither a constructor nor a factory.`,
      `Provide 'useFactory' or 'useValue'.`,
    ];
    super(format(`Relic '${token}' cannot be constructed.`, dev));
    this.name = 'UnconstructableRelicError';
  }
}

export class LazyFusionResolverMissingError extends Error {
  constructor() {
    const dev = [
      'Lazy fusion resolver missing',
      '',
      `Lazy fusion resolver is unavailable. Import 'Genesis' before constructing vaults that fuse classes.`,
    ];
    super(format('Lazy fusion resolver unavailable.', dev));
    this.name = 'LazyFusionResolverMissingError';
  }
}

export class FactoryExecutionError extends Error {
  constructor(
    public token: string,
    cause: unknown
  ) {
    const dev = [
      'Factory execution failed',
      '',
      `Factory for '${token}' threw during creation. See 'cause' for details.`,
    ];
    super(format(`Factory for '${token}' failed during creation.`, dev), {
      cause: cause,
    });
    this.name = 'FactoryExecutionError';
  }
}

export class ScopeDisposedError extends Error {
  constructor() {
    const dev = [
      'Scope disposed',
      '',
      'Scope has been disposed. Do not resolve scoped relics after endScope().',
    ];
    super(format('Scope has been disposed.', dev));
    this.name = 'ScopeDisposedError';
  }
}

export class InvalidVaultConfigError extends Error {
  constructor(public reason: string) {
    const dev = ['Invalid vault configuration', '', `Invalid vault configuration: ${reason}`];
    super(format(`Invalid vault configuration: ${reason}`, dev));
    this.name = 'InvalidVaultConfigError';
  }
}

export class ShadowPolicyViolationError extends Error {
  constructor(
    public vaultName: string,
    public owners: string[],
    public canonical: string,
    public lifecycle: string
  ) {
    const ownersList = Array.from(new Set(owners)).join(', ');
    const dev = [
      `Shadowing detected for token '${canonical}' in vault '${vaultName}'`,
      `Also exposed by: ${ownersList}`,
      '',
      `This vault registers '${canonical}' locally, and a fused aether/revealed vault also exposes it.`,
      '',
      'To fix:',
      `  1) Use aethered vault: remove '${canonical}' from this vault's 'relics'.`,
      `  2) Keep local service intentionally: set shadowPolicy: 'allow' on this vault.`,
      `  3) Rename your local token (e.g., provide: 'Local${canonical}').`,
      `  4) Or remove '${canonical}' from the producer's 'reveal' list.`,
    ];
    super(format(`Shadowed token '${canonical}' detected in vault '${vaultName}'.`, dev));
    this.name = 'ShadowPolicyViolationError';
  }
}

export class VaultDisposedError extends Error {
  constructor(public vaultName: string) {
    const dev = [
      `Vault '${vaultName}' has been disposed.`,
      '',
      'Dispose is irreversible. Re-create the vault before attempting new resolutions.',
    ];
    super(format(`Vault '${vaultName}' has been disposed.`, dev));
    this.name = 'VaultDisposedError';
  }
}

export class ScopedWithoutScopeError extends Error {
  constructor(
    public token: string,
    public dependencyChain?: string[]
  ) {
    const parts: string[] = [`Cannot resolve scoped relic '${token}' without a scope.`, ''];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${token}`, '');
    }

    parts.push(
      `Relic '${token}' is registered with Lifecycle.Scoped but no scope was provided.`,
      '',
      'To fix this:',
      '  1. Pass a scope when resolving:',
      '     const scope = MyVault.beginScope();',
      '     const instance = vault.resolve(Token, { scope });',
      '     await scope.dispose();',
      '',
      '  2. Or change the lifecycle to Singleton or Transient if scoping is not needed.',
      ''
    );

    super(format(`Cannot resolve scoped relic '${token}' without a scope.`, parts));
    this.name = 'ScopedWithoutScopeError';
  }
}

export class InvalidTokenError extends Error {
  constructor(public token: unknown) {
    let tokenString: string;
    try {
      tokenString = JSON.stringify(token);
    } catch {
      tokenString = String(token);
    }

    const dev = [
      'Invalid token parameter',
      '',
      `Expected a valid Token object with 'id' property.`,
      '',
      'Received:',
      `  ${tokenString}`,
      '',
      'Valid token usage:',
      `  - Token.for('ServiceName')`,
      `  - Token.for('ServiceName', { ... })`,
      `  - class ServiceT extends Token<ServiceClass>('ServiceName') {}`,
    ];

    super(format('Invalid token parameter.', dev));
    this.name = 'InvalidTokenError';
  }
}

export class LazyResolverInvalidReturnError extends Error {
  constructor(
    public className: string,
    public returnValue: unknown
  ) {
    let valueString: string;
    try {
      valueString = String(returnValue);
    } catch {
      valueString = typeof returnValue;
    }

    const dev = [
      'Lazy fusion resolver returned invalid value',
      '',
      `Lazy resolver for class '${className}' must return a Vault instance.`,
      '',
      'Received:',
      `  ${valueString}`,
      '',
      'Expected:',
      `  A Vault instance created via Genesis.from(${className}) or new Vault()`,
    ];

    super(format(`Lazy resolver for '${className}' must return a Vault instance.`, dev));
    this.name = 'LazyResolverInvalidReturnError';
  }
}

/**
 * Error thrown when multiple disposal operations fail.
 *
 * This error aggregates all disposal errors that occurred while attempting
 * to dispose a vault's instances. Each individual error is preserved in the
 * `errors` array for detailed diagnostics.
 */
export class AggregateDisposalError extends Error {
  constructor(public errors: Error[]) {
    const errorList = errors.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
    const dev = [
      'Multiple disposal errors occurred',
      '',
      `${errors.length} error(s) occurred during vault disposal:`,
      errorList,
      '',
      'Check the `errors` property for detailed information about each failure.',
    ];

    super(format(`${errors.length} disposal error(s) occurred.`, dev));
    this.name = 'AggregateDisposalError';
  }
}

/**
 * Shadow policy violation error that reports multiple violations at once.
 *
 * This error is thrown when multiple tokens violate the shadow policy,
 * providing a comprehensive view of all conflicts detected.
 */
export class MultipleShadowPolicyViolationsError extends Error {
  constructor(
    public vaultName: string,
    public violations: Array<{ token: string; producers: string[]; lifecycle: string }>
  ) {
    const violationsList = violations
      .map((v) => `  - Token '${v.token}' (${v.lifecycle}) shadowed by: ${v.producers.join(', ')}`)
      .join('\n');

    const dev = [
      `Multiple shadow policy violations detected in vault '${vaultName}'`,
      '',
      violationsList,
      '',
      'To fix:',
      `  1) Use aethered vault: remove these tokens from this vault's 'relics'.`,
      `  2) Keep local services intentionally: set shadowPolicy: 'allow' on this vault.`,
      `  3) Rename your local tokens to avoid conflicts.`,
      `  4) Or remove these tokens from the producer vaults' 'reveal' lists.`,
    ];

    super(
      format(
        `${violations.length} shadow policy violation(s) detected in vault '${vaultName}'.`,
        dev
      )
    );
    this.name = 'MultipleShadowPolicyViolationsError';
  }
}

/**
 * Error thrown when a lifecycle dependency rule is violated.
 *
 * Lifecycle rules:
 * - Singleton relics CANNOT depend on Scoped relics (would capture first scope's instance)
 * - Singleton relics CANNOT depend on Transient relics (would capture first transient instance)
 * - Scoped relics CAN depend on Singleton relics (singletons are global)
 * - Scoped relics CANNOT depend on Transient relics (unclear semantics)
 * - Transient relics CAN depend on any lifecycle (each resolution is independent)
 */
export class LifecycleViolationError extends Error {
  constructor(
    public consumerToken: string,
    public consumerLifecycle: string,
    public dependencyToken: string,
    public dependencyLifecycle: string,
    public dependencyChain?: string[]
  ) {
    const parts: string[] = [
      `Lifecycle violation: ${consumerLifecycle} relic '${consumerToken}' ` +
        `cannot depend on ${dependencyLifecycle} relic '${dependencyToken}'.`,
      '',
    ];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${dependencyToken}`, '');
    }

    parts.push('Why this is an error:', '');

    if (consumerLifecycle === 'singleton' && dependencyLifecycle === 'scoped') {
      parts.push(
        `  Singleton relics live for the entire application lifetime.`,
        `  Scoped relics are isolated per scope (e.g., per HTTP request).`,
        `  If a singleton depends on a scoped relic, it would capture the`,
        `  first scope's instance, defeating the purpose of scoping.`,
        ''
      );
    } else if (consumerLifecycle === 'singleton' && dependencyLifecycle === 'transient') {
      parts.push(
        `  Singleton relics live for the entire application lifetime.`,
        `  Transient relics are created fresh for every resolution.`,
        `  If a singleton depends on a transient relic, it would capture`,
        `  the first transient instance, defeating the purpose of transient lifecycle.`,
        ''
      );
    } else if (consumerLifecycle === 'scoped' && dependencyLifecycle === 'transient') {
      parts.push(
        `  Scoped relics are isolated per scope.`,
        `  Transient relics are created fresh for every resolution.`,
        `  The semantics of a scoped relic depending on a transient are unclear.`,
        `  Use a scoped factory pattern instead.`,
        ''
      );
    }

    parts.push(
      'To fix this:',
      `  1. Change '${consumerToken}' to ${dependencyLifecycle} lifecycle`,
      `  2. Change '${dependencyToken}' to ${consumerLifecycle} lifecycle`,
      `  3. Restructure your dependencies to follow lifecycle rules`,
      ''
    );

    super(format(`Lifecycle violation: ${consumerLifecycle} → ${dependencyLifecycle}`, parts));
    this.name = 'LifecycleViolationError';
  }
}
