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
 * Provider not found error with helpful suggestions
 */
export class ProviderNotFoundError extends Error {
  constructor(
    public token: string,
    public availableRelics: string[],
    public dependencyChain?: string[]
  ) {
    const parts: string[] = [`Cannot resolve provider '${token}'.`, ''];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${token}`, '');
    }

    if (availableRelics.length > 0 && availableRelics.length <= 10) {
      parts.push('Available providers:');
      availableRelics.forEach((r) => parts.push(`  - ${r}`));
      parts.push('');
    } else if (availableRelics.length > 10) {
      parts.push(`\n${availableRelics.length} providers are registered.`);
    }

    parts.push('To fix this:');
    parts.push(`  1. Add @Injectable() decorator to ${token}`);
    parts.push(`  2. Include it in the 'providers' array when constructing the module`);
    parts.push(`  3. Check for typos in @Inject('${token}') or provider tokens`, '');

    super(format(`Cannot resolve provider '${token}'.`, parts));
    this.name = 'ProviderNotFoundError';
  }
}

/** @deprecated Use ProviderNotFoundError instead */
export const RelicNotFoundError = ProviderNotFoundError;

export class MissingInjectDecoratorError extends Error {
  constructor(
    public className: string,
    public parameterIndex: number
  ) {
    const dev = [
      'Missing @Inject decorator',
      '',
      `Parameter ${parameterIndex} of ${className} is missing a @Inject decorator.`,
      '',
      'Fix:',
      `  - Add @Inject(SomeService) to the constructor parameter at index ${parameterIndex}`,
      '',
      'Example:',
      `  @Injectable()`,
      `  class ${className} {`,
      `    constructor(`,
      `      @Inject(SomeService) private service: SomeService`,
      `    ) {}`,
      `  }`,
    ];
    super(format(`Missing @Inject decorator at parameter ${parameterIndex} of ${className}.`, dev));
    this.name = 'MissingInjectDecoratorError';
  }
}

/** @deprecated Use MissingInjectDecoratorError instead */
export const MissingSummonDecoratorError = MissingInjectDecoratorError;

export class ProviderNotExposedError extends Error {
  constructor(
    public token: string,
    public vaultName: string,
    public revealedRelics: string[]
  ) {
    const dev = [
      `Provider '${token}' is not exported by module '${vaultName}'.`,
      '',
      `This provider exists in '${vaultName}' but was not included in the 'exports' list.`,
      `Only exported providers can be accessed from importing modules.`,
      '',
      ...(revealedRelics.length > 0
        ? ['Exported providers:', ...revealedRelics.map((r) => `  - ${r}`)]
        : [`Module '${vaultName}' does not export any providers.`]),
      '',
      'To fix this:',
      `  1. Add '${token}' to the 'exports' array in module '${vaultName}'`,
      `  2. Or register '${token}' directly in the current module`,
    ];
    super(format(`Provider '${token}' is not exported by module '${vaultName}'.`, dev));
    this.name = 'ProviderNotExposedError';
  }
}

/** @deprecated Use ProviderNotExposedError instead */
export const RelicNotExposedError = ProviderNotExposedError;

export class CircularModuleAttachmentError extends Error {
  constructor(public cycle: string[]) {
    const cycleStr = cycle.join(' → ');
    const dev = [
      'Circular module import detected:',
      '',
      `  ${cycleStr}`,
      '',
      'Modules cannot import each other in a circular manner.',
      '',
      'To fix this:',
      `  1. Reorganize module hierarchy to be tree-shaped (no cycles)`,
      `  2. Extract shared providers into a separate base module`,
      `  3. Have both modules import the base module instead`,
    ];
    super(format(`Circular module import detected: ${cycleStr}`, dev));
    this.name = 'CircularModuleAttachmentError';
  }
}

/** @deprecated Use CircularModuleAttachmentError instead */
export const CircularVaultAttachmentError = CircularModuleAttachmentError;

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
      `  - A class constructor decorated with @Injectable()`,
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
      `Token '${token}' is already registered in module '${existingOwner}', cannot re-register in '${newOwner}'.`,
    ];
    super(format(`Token '${token}' already registered in '${existingOwner}'.`, dev));
    this.name = 'TokenCollisionError';
  }
}

export class MissingInjectableDecoratorError extends Error {
  constructor(public ctorName: string) {
    const dev = [
      'Missing @Injectable decorator',
      '',
      `Class ${ctorName} is not decorated with @Injectable().`,
      `Decorate it with @Injectable() or register it via an explicit provider.`,
    ];
    super(format(`Class ${ctorName} must be decorated with @Injectable().`, dev));
    this.name = 'MissingInjectableDecoratorError';
  }
}

/** @deprecated Use MissingInjectableDecoratorError instead */
export const MissingRelicDecoratorError = MissingInjectableDecoratorError;

export class UnconstructableProviderError extends Error {
  constructor(public token: string) {
    const dev = [
      'Unconstructable provider',
      '',
      `Provider '${token}' has neither a constructor nor a factory.`,
      `Provide 'useFactory' or 'useValue'.`,
    ];
    super(format(`Provider '${token}' cannot be constructed.`, dev));
    this.name = 'UnconstructableProviderError';
  }
}

/** @deprecated Use UnconstructableProviderError instead */
export const UnconstructableRelicError = UnconstructableProviderError;

export class LazyFusionResolverMissingError extends Error {
  constructor() {
    const dev = [
      'Lazy import resolver missing',
      '',
      `Lazy import resolver is unavailable. Import 'Container' before constructing modules that import classes.`,
    ];
    super(format('Lazy import resolver unavailable.', dev));
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
      'Scope has been disposed. Do not resolve scoped providers after endScope().',
    ];
    super(format('Scope has been disposed.', dev));
    this.name = 'ScopeDisposedError';
  }
}

export class InvalidModuleConfigError extends Error {
  constructor(public reason: string) {
    const dev = ['Invalid module configuration', '', `Invalid module configuration: ${reason}`];
    super(format(`Invalid module configuration: ${reason}`, dev));
    this.name = 'InvalidModuleConfigError';
  }
}

/** @deprecated Use InvalidModuleConfigError instead */
export const InvalidVaultConfigError = InvalidModuleConfigError;

export class ShadowPolicyViolationError extends Error {
  constructor(
    public vaultName: string,
    public owners: string[],
    public canonical: string,
    public lifecycle: string
  ) {
    const ownersList = Array.from(new Set(owners)).join(', ');
    const dev = [
      `Shadowing detected for token '${canonical}' in module '${vaultName}'`,
      `Also exposed by: ${ownersList}`,
      '',
      `This module registers '${canonical}' locally, and an imported global/exported module also exposes it.`,
      '',
      'To fix:',
      `  1) Use global module: remove '${canonical}' from this module's 'providers'.`,
      `  2) Keep local service intentionally: set shadowPolicy: 'allow' on this module.`,
      `  3) Rename your local token (e.g., provide: 'Local${canonical}').`,
      `  4) Or remove '${canonical}' from the producer's 'exports' list.`,
    ];
    super(format(`Shadowed token '${canonical}' detected in module '${vaultName}'.`, dev));
    this.name = 'ShadowPolicyViolationError';
  }
}

export class ContainerDisposedError extends Error {
  constructor(public vaultName: string) {
    const dev = [
      `Container '${vaultName}' has been disposed.`,
      '',
      'Dispose is irreversible. Re-create the container before attempting new resolutions.',
    ];
    super(format(`Container '${vaultName}' has been disposed.`, dev));
    this.name = 'ContainerDisposedError';
  }
}

/** @deprecated Use ContainerDisposedError instead */
export const VaultDisposedError = ContainerDisposedError;

export class ScopedWithoutScopeError extends Error {
  constructor(
    public token: string,
    public dependencyChain?: string[]
  ) {
    const parts: string[] = [`Cannot resolve scoped provider '${token}' without a scope.`, ''];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${token}`, '');
    }

    parts.push(
      `Provider '${token}' is registered with Lifecycle.Scoped but no scope was provided.`,
      '',
      'To fix this:',
      '  1. Pass a scope when resolving:',
      '     const scope = MyModule.beginScope();',
      '     const instance = vault.resolve(Token, { scope });',
      '     await scope.dispose();',
      '',
      '  2. Or change the lifecycle to Singleton or Transient if scoping is not needed.',
      ''
    );

    super(format(`Cannot resolve scoped provider '${token}' without a scope.`, parts));
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
      `Expected a valid Token object created with token<T>().`,
      '',
      'Received:',
      `  ${tokenString}`,
      '',
      'Valid token usage:',
      `  const MyToken = token<MyService>('MyService');`,
      `  vault.resolve(MyToken);`,
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
      'Lazy import resolver returned invalid value',
      '',
      `Lazy resolver for class '${className}' must return a Vault instance.`,
      '',
      'Received:',
      `  ${valueString}`,
      '',
      'Expected:',
      `  A Vault instance created via Container.from(${className}) or new Vault()`,
    ];

    super(format(`Lazy resolver for '${className}' must return a Vault instance.`, dev));
    this.name = 'LazyResolverInvalidReturnError';
  }
}

/**
 * Error thrown when multiple disposal operations fail.
 *
 * This error aggregates all disposal errors that occurred while attempting
 * to dispose a container's instances. Each individual error is preserved in the
 * `errors` array for detailed diagnostics.
 */
export class AggregateDisposalError extends Error {
  constructor(public errors: Error[]) {
    const errorList = errors.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
    const dev = [
      'Multiple disposal errors occurred',
      '',
      `${errors.length} error(s) occurred during container disposal:`,
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
      `Multiple shadow policy violations detected in module '${vaultName}'`,
      '',
      violationsList,
      '',
      'To fix:',
      `  1) Use global module: remove these tokens from this module's 'providers'.`,
      `  2) Keep local services intentionally: set shadowPolicy: 'allow' on this module.`,
      `  3) Rename your local tokens to avoid conflicts.`,
      `  4) Or remove these tokens from the producer modules' 'exports' lists.`,
    ];

    super(
      format(
        `${violations.length} shadow policy violation(s) detected in module '${vaultName}'.`,
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
 * - Singleton providers CANNOT depend on Scoped providers (would capture first scope's instance)
 * - Singleton providers CANNOT depend on Transient providers (would capture first transient instance)
 * - Scoped providers CAN depend on Singleton providers (singletons are global)
 * - Scoped providers CANNOT depend on Transient providers (unclear semantics)
 * - Transient providers CAN depend on any lifecycle (each resolution is independent)
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
      `Lifecycle violation: ${consumerLifecycle} provider '${consumerToken}' ` +
        `cannot depend on ${dependencyLifecycle} provider '${dependencyToken}'.`,
      '',
    ];

    if (dependencyChain && dependencyChain.length > 0) {
      const chain = dependencyChain.join(' → ');
      parts.push('Dependency chain:', `  ${chain} → ${dependencyToken}`, '');
    }

    parts.push('Why this is an error:', '');

    if (consumerLifecycle === 'singleton' && dependencyLifecycle === 'scoped') {
      parts.push(
        `  Singleton providers live for the entire application lifetime.`,
        `  Scoped providers are isolated per scope (e.g., per HTTP request).`,
        `  If a singleton depends on a scoped provider, it would capture the`,
        `  first scope's instance, defeating the purpose of scoping.`,
        ''
      );
    } else if (consumerLifecycle === 'singleton' && dependencyLifecycle === 'transient') {
      parts.push(
        `  Singleton providers live for the entire application lifetime.`,
        `  Transient providers are created fresh for every resolution.`,
        `  If a singleton depends on a transient provider, it would capture`,
        `  the first transient instance, defeating the purpose of transient lifecycle.`,
        ''
      );
    } else if (consumerLifecycle === 'scoped' && dependencyLifecycle === 'transient') {
      parts.push(
        `  Scoped providers are isolated per scope.`,
        `  Transient providers are created fresh for every resolution.`,
        `  The semantics of a scoped provider depending on a transient are unclear.`,
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
