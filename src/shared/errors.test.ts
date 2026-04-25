import { describe, it, expect } from 'vitest';
import {
  AgenticHostingError,
  ProtocolError,
  AuthorizationError,
  TemplateNotFoundError,
  InstanceNotFoundError,
  InvalidStateTransitionError,
  DockerError,
  HelloTimeoutError,
  DuplicateInstanceNameError,
  ConfigError,
  PayloadValidationError,
  SpawnAbortedError,
} from './errors.js';

describe('Error hierarchy', () => {
  it('all errors extend AgenticHostingError', () => {
    const errors = [
      new ProtocolError('test'),
      new AuthorizationError('test'),
      new TemplateNotFoundError('tmpl-1'),
      new InstanceNotFoundError('inst-1'),
      new InvalidStateTransitionError('inst-1', 'CREATED', 'RUNNING'),
      new DockerError('test'),
      new HelloTimeoutError('inst-1', 60000),
      new DuplicateInstanceNameError('my-bot'),
      new ConfigError('test'),
      new PayloadValidationError('bad env'),
      new SpawnAbortedError('inst-1'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(AgenticHostingError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('AgenticHostingError has code and message', () => {
    const err = new AgenticHostingError('something failed', 'SOME_CODE');
    expect(err.message).toBe('something failed');
    expect(err.code).toBe('SOME_CODE');
    expect(err.name).toBe('AgenticHostingError');
  });

  it('ProtocolError has correct code', () => {
    const err = new ProtocolError('bad message');
    expect(err.code).toBe('PROTOCOL_ERROR');
    expect(err.name).toBe('ProtocolError');
  });

  it('AuthorizationError has correct code', () => {
    const err = new AuthorizationError('not allowed');
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('TemplateNotFoundError includes template id', () => {
    const err = new TemplateNotFoundError('my-template');
    expect(err.message).toContain('my-template');
    expect(err.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('InstanceNotFoundError includes identifier', () => {
    const err = new InstanceNotFoundError('abc-123');
    expect(err.message).toContain('abc-123');
    expect(err.code).toBe('INSTANCE_NOT_FOUND');
  });

  it('InvalidStateTransitionError includes details', () => {
    const err = new InvalidStateTransitionError('inst-1', 'CREATED', 'RUNNING');
    expect(err.message).toContain('inst-1');
    expect(err.message).toContain('CREATED');
    expect(err.message).toContain('RUNNING');
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('DockerError has correct code', () => {
    const err = new DockerError('container failed');
    expect(err.code).toBe('DOCKER_ERROR');
  });

  it('HelloTimeoutError includes timeout', () => {
    const err = new HelloTimeoutError('inst-1', 60000);
    expect(err.message).toContain('inst-1');
    expect(err.message).toContain('60000');
    expect(err.code).toBe('HELLO_TIMEOUT');
  });

  it('DuplicateInstanceNameError includes name', () => {
    const err = new DuplicateInstanceNameError('alice-bot');
    expect(err.message).toContain('alice-bot');
    expect(err.code).toBe('DUPLICATE_NAME');
  });

  it('ConfigError has correct code', () => {
    const err = new ConfigError('missing var');
    expect(err.code).toBe('CONFIG_ERROR');
  });

  it('PayloadValidationError has correct code', () => {
    const err = new PayloadValidationError('bad env var');
    expect(err.code).toBe('INVALID_PAYLOAD');
  });

  it('SpawnAbortedError includes instance id', () => {
    const err = new SpawnAbortedError('inst-1');
    expect(err.message).toContain('inst-1');
    expect(err.code).toBe('SPAWN_ABORTED');
  });
});
