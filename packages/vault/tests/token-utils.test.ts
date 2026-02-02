import { describe, expect, it } from 'vitest';
import { createTokenGroup } from '../src/api/token-utils.js';
import { token } from '../src/core/token.js';

describe('createTokenGroup', () => {
  it('should create tokens with labels that include the prefix', () => {
    interface UserModule {
      Repository: UserRepository;
      Service: UserService;
      Controller: UserController;
    }

    class UserRepository {}
    class UserService {}
    class UserController {}

    const tokens = createTokenGroup<UserModule>('User', {
      Repository: null as any,
      Service: null as any,
      Controller: null as any,
    });

    expect(tokens.Repository.label).toBe('UserRepository');
    expect(tokens.Service.label).toBe('UserService');
    expect(tokens.Controller.label).toBe('UserController');

    // Tokens should have unique IDs
    expect(tokens.Repository.id).toMatch(/^tok_\d+$/);
    expect(tokens.Service.id).toMatch(/^tok_\d+$/);
    expect(tokens.Controller.id).toMatch(/^tok_\d+$/);
  });

  it('should have type inference work correctly', () => {
    interface AuthTokens {
      Provider: AuthProvider;
      Guard: AuthGuard;
    }

    class AuthProvider {}
    class AuthGuard {}

    const tokens = createTokenGroup<AuthTokens>('Auth', {
      Provider: null as any,
      Guard: null as any,
    });

    // Type assertions to verify type inference
    const _provider: typeof tokens.Provider extends { id: string } ? true : false = true;
    const _guard: typeof tokens.Guard extends { id: string } ? true : false = true;

    expect(_provider).toBe(true);
    expect(_guard).toBe(true);
  });

  it('should return object with expected keys', () => {
    const tokens = createTokenGroup('Test', {
      One: null as string,
      Two: null as number,
      Three: null as boolean,
    });

    expect(Object.keys(tokens)).toEqual(['One', 'Two', 'Three']);
    expect(tokens.One).toBeDefined();
    expect(tokens.Two).toBeDefined();
    expect(tokens.Three).toBeDefined();
  });

  it('should handle empty objects', () => {
    const tokens = createTokenGroup('Empty', {});

    expect(Object.keys(tokens)).toEqual([]);
  });

  it('should handle special characters in prefix', () => {
    const tokens = createTokenGroup('My-Module/', {
      Service: null as string,
    });

    expect(tokens.Service.label).toBe('My-Module/Service');
  });

  it('should create unique tokens for each key', () => {
    const tokens = createTokenGroup('App', {
      ServiceA: null as string,
      ServiceB: null as string,
    });

    expect(tokens.ServiceA).not.toBe(tokens.ServiceB);
    expect(tokens.ServiceA.id).not.toBe(tokens.ServiceB.id);
    expect(tokens.ServiceA.label).toBe('AppServiceA');
    expect(tokens.ServiceB.label).toBe('AppServiceB');
  });

  it('should not inherit properties from prototype chain', () => {
    // Create an object with a prototype
    const proto = { inherited: null as string };
    const names = Object.create(proto);
    names.own = null as string;

    const tokens = createTokenGroup('Test', names);

    // Should only have 'own', not 'inherited'
    expect(Object.keys(tokens)).toEqual(['own']);
    expect(tokens.own).toBeDefined();
    expect('inherited' in tokens).toBe(false);
  });

  it('should work with number keys', () => {
    const tokens = createTokenGroup('Version', {
      1: null as string,
      2: null as string,
    });

    expect(tokens[1].label).toBe('Version1');
    expect(tokens[2].label).toBe('Version2');
  });

  it('should be compatible with manually created tokens', () => {
    const manualToken = token<string>('UserService');
    const groupTokens = createTokenGroup('User', {
      Service: null as string,
    });

    // Both should have the same structure
    expect(typeof manualToken.id).toBe('string');
    expect(typeof groupTokens.Service.id).toBe('string');
    expect(manualToken.kind).toBe('token');
    expect(groupTokens.Service.kind).toBe('token');

    // Both should have labels
    expect(manualToken.label).toBe('UserService');
    expect(groupTokens.Service.label).toBe('UserService');
  });

  it('should handle complex type parameters', () => {
    interface Complex {
      Handler: (req: string) => Promise<void>;
      Validator: { validate: (input: unknown) => boolean };
      Config: { port: number; host: string };
    }

    const tokens = createTokenGroup<Complex>('API', {
      Handler: null as any,
      Validator: null as any,
      Config: null as any,
    });

    expect(tokens.Handler.label).toBe('APIHandler');
    expect(tokens.Validator.label).toBe('APIValidator');
    expect(tokens.Config.label).toBe('APIConfig');
  });
});
