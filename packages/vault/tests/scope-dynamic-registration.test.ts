/**
 * Tests for Phase 0 Feature 1: Dynamic Scope Registration
 *
 * Tests the new scope methods:
 * - provide(): Register scope-local values
 * - has(): Check if token exists in scope or vault
 * - tryResolve(): Safe resolution with fallback
 * - override(): Replace existing registrations
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Genesis } from '../src/api/genesis';
import type { Scope } from '../src/core/scope';
import { token } from '../src/core/token';
import type { Vault } from '../src/core/vault';
import { Relic, Summon, Vault as VaultDecorator } from '../src/decorators';

// Test tokens
const ConfigT = token<Config>('Config');
const DatabaseT = token<Database>('Database');
const LoggerT = token<Logger>('Logger');
const UserServiceT = token<UserService>('UserService');
const UnregisteredT = token<unknown>('Unregistered'); // Token not in vault

// Test classes
class Config {
  constructor(public readonly env: string = 'test') {}
}

@Relic({ provide: ConfigT })
class VaultConfig extends Config {
  constructor() {
    super('vault');
  }
}

class Database {
  constructor(public readonly url: string = 'test://db') {}
  dispose() {
    // Cleanup marker
  }
}

class Logger {
  logs: string[] = [];
  log(message: string) {
    this.logs.push(message);
  }
}

@Relic({ provide: UserServiceT })
class UserService {
  constructor(
    @Summon(DatabaseT) public readonly db: Database,
    @Summon(LoggerT) public readonly logger: Logger
  ) {}
}

@VaultDecorator({
  relics: [UserService, VaultConfig],
  reveal: [UserServiceT, ConfigT],
})
class TestVault {}

describe('Scope Dynamic Registration - Phase 0.1', () => {
  let vault: Vault;
  let scope: Scope;

  beforeEach(() => {
    vault = Genesis.from(TestVault);
    scope = vault.createScope();
  });

  describe('provide()', () => {
    it('should register a scope-local value', () => {
      const config = new Config('production');
      scope.provide(ConfigT, config);

      const resolved = scope.resolve(ConfigT);
      expect(resolved).toBe(config);
      expect(resolved.env).toBe('production');
    });

    it('should override vault registration', () => {
      // Vault has VaultConfig registered (from decorators)
      // Verify vault has it
      const vaultConfig = vault.resolve(ConfigT);
      expect(vaultConfig.env).toBe('vault');

      // Override in scope
      const scopeConfig = new Config('scope');
      scope.provide(ConfigT, scopeConfig);

      const resolved = scope.resolve(ConfigT);
      expect(resolved).toBe(scopeConfig);
      expect(resolved.env).toBe('scope');
    });

    it('should automatically register cleanup for disposable instances', () => {
      const db = new Database();
      let disposed = false;
      db.dispose = () => {
        disposed = true;
      };

      scope.provide(DatabaseT, db);
      scope.disposeSync();

      expect(disposed).toBe(true);
    });

    it('should support multiple scope-local registrations', () => {
      const config = new Config('test');
      const logger = new Logger();
      const db = new Database();

      scope.provide(ConfigT, config);
      scope.provide(LoggerT, logger);
      scope.provide(DatabaseT, db);

      expect(scope.resolve(ConfigT)).toBe(config);
      expect(scope.resolve(LoggerT)).toBe(logger);
      expect(scope.resolve(DatabaseT)).toBe(db);
    });

    it('should throw ScopeDisposedError if scope is disposed', () => {
      scope.disposeSync();

      expect(() => scope.provide(ConfigT, new Config())).toThrow();
    });
  });

  describe('has()', () => {
    it('should return true for scope-local registrations', () => {
      scope.provide(ConfigT, new Config());
      expect(scope.has(ConfigT)).toBe(true);
    });

    it('should return true for vault registrations', () => {
      // UserService is registered in vault
      expect(scope.has(UserServiceT)).toBe(true);
    });

    it('should return false for unregistered tokens', () => {
      expect(scope.has(UnregisteredT)).toBe(false);
    });

    it('should prioritize scope-local over vault', () => {
      // Vault already has ConfigT registered as VaultConfig
      scope.provide(ConfigT, new Config('scope'));

      expect(scope.has(ConfigT)).toBe(true);
      expect(scope.resolve(ConfigT).env).toBe('scope');
    });

    it('should return false when scope is disposed', () => {
      scope.provide(ConfigT, new Config());
      scope.disposeSync();

      expect(scope.has(ConfigT)).toBe(false);
    });
  });

  describe('tryResolve()', () => {
    it('should return value for registered tokens', () => {
      const config = new Config();
      scope.provide(ConfigT, config);

      const resolved = scope.tryResolve(ConfigT);
      expect(resolved).toBe(config);
    });

    it('should return undefined for unregistered tokens', () => {
      const resolved = scope.tryResolve(UnregisteredT);
      expect(resolved).toBeUndefined();
    });

    it('should return undefined when scope is disposed', () => {
      scope.provide(ConfigT, new Config());
      scope.disposeSync();

      const resolved = scope.tryResolve(ConfigT);
      expect(resolved).toBeUndefined();
    });

    it('should enable fallback patterns', () => {
      const defaultLogger = new Logger();
      const logger = scope.tryResolve(LoggerT) ?? defaultLogger;

      expect(logger).toBe(defaultLogger);
      logger.log('test');
      expect(logger.logs).toEqual(['test']);
    });
  });

  describe('override()', () => {
    it('should replace existing scope-local registration', () => {
      const config1 = new Config('first');
      const config2 = new Config('second');

      scope.provide(ConfigT, config1);
      scope.override(ConfigT, config2);

      const resolved = scope.resolve(ConfigT);
      expect(resolved).toBe(config2);
      expect(resolved.env).toBe('second');
    });

    it('should override vault registration', () => {
      // Vault has VaultConfig registered
      const scopeConfig = new Config('override');
      scope.override(ConfigT, scopeConfig);

      expect(scope.resolve(ConfigT)).toBe(scopeConfig);
    });

    it('should throw when scope is disposed', () => {
      scope.disposeSync();
      expect(() => scope.override(ConfigT, new Config())).toThrow();
    });
  });

  describe('Scope-local resolution precedence', () => {
    it('should resolve scope-local before vault', () => {
      // Vault has VaultConfig registered

      // Scope registration
      const scopeConfig = new Config('scope');
      scope.provide(ConfigT, scopeConfig);

      // Should get scope version
      expect(scope.resolve(ConfigT)).toBe(scopeConfig);

      // Vault should still have its own version
      expect(vault.resolve(ConfigT)).not.toBe(scopeConfig);
      expect(vault.resolve(ConfigT).env).toBe('vault');
    });

    it('should fall back to vault when not in scope', () => {
      // Vault has VaultConfig registered

      // No scope registration, should get vault version
      const resolved = scope.resolve(ConfigT);
      expect(resolved.env).toBe('vault');
    });
  });

  describe('Disposal cleanup', () => {
    it('should cleanup scope-local instances on dispose', async () => {
      const db = new Database();
      let disposed = false;
      db.dispose = () => {
        disposed = true;
      };

      scope.provide(DatabaseT, db);
      await scope.dispose();

      expect(disposed).toBe(true);
    });

    it('should cleanup scope-local instances on disposeSync', () => {
      const db = new Database();
      let disposed = false;
      db.dispose = () => {
        disposed = true;
      };

      scope.provide(DatabaseT, db);
      scope.disposeSync();

      expect(disposed).toBe(true);
    });

    it('should cleanup multiple scope-local instances', async () => {
      const disposals: string[] = [];

      const db = new Database();
      db.dispose = () => disposals.push('db');

      const logger = new Logger();
      (logger as any).dispose = () => disposals.push('logger');

      scope.provide(DatabaseT, db);
      scope.provide(LoggerT, logger);

      await scope.dispose();

      expect(disposals).toContain('db');
      expect(disposals).toContain('logger');
    });
  });

  describe('Multiple scopes independence', () => {
    it('should isolate scope-local registrations between scopes', () => {
      const scope1 = vault.createScope();
      const scope2 = vault.createScope();

      const config1 = new Config('scope1');
      const config2 = new Config('scope2');

      scope1.provide(ConfigT, config1);
      scope2.provide(ConfigT, config2);

      expect(scope1.resolve(ConfigT)).toBe(config1);
      expect(scope2.resolve(ConfigT)).toBe(config2);
    });

    it('should not interfere with each other during disposal', async () => {
      const scope1 = vault.createScope();
      const scope2 = vault.createScope();

      const disposals: string[] = [];

      const db1 = new Database();
      db1.dispose = () => disposals.push('db1');

      const db2 = new Database();
      db2.dispose = () => disposals.push('db2');

      scope1.provide(DatabaseT, db1);
      scope2.provide(DatabaseT, db2);

      await scope1.dispose();
      expect(disposals).toEqual(['db1']);

      await scope2.dispose();
      expect(disposals).toEqual(['db1', 'db2']);
    });
  });

  describe('Integration with vault resolution', () => {
    it('should use scope-local dependencies during resolution', () => {
      // Provide scope-local database and logger
      const scopeDb = new Database('scope://db');
      const scopeLogger = new Logger();

      scope.provide(DatabaseT, scopeDb);
      scope.provide(LoggerT, scopeLogger);

      // Resolve UserService which depends on Database and Logger
      const userService = scope.resolve(UserServiceT);

      // Should use scope-local instances
      expect(userService.db).toBe(scopeDb);
      expect(userService.logger).toBe(scopeLogger);
    });
  });
});
