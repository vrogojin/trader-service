/**
 * Typed error hierarchy for agentic hosting.
 */

export class AgenticHostingError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AgenticHostingError';
  }
}

export class ProtocolError extends AgenticHostingError {
  constructor(message: string) {
    super(message, 'PROTOCOL_ERROR');
    this.name = 'ProtocolError';
  }
}

export class AuthorizationError extends AgenticHostingError {
  constructor(message: string) {
    super(message, 'UNAUTHORIZED');
    this.name = 'AuthorizationError';
  }
}

export class TemplateNotFoundError extends AgenticHostingError {
  constructor(templateId: string) {
    super(`Template not found: ${templateId}`, 'TEMPLATE_NOT_FOUND');
    this.name = 'TemplateNotFoundError';
  }
}

export class InstanceNotFoundError extends AgenticHostingError {
  constructor(identifier: string) {
    super(`Instance not found: ${identifier}`, 'INSTANCE_NOT_FOUND');
    this.name = 'InstanceNotFoundError';
  }
}

export class InvalidStateTransitionError extends AgenticHostingError {
  constructor(instanceId: string, from: string, to: string) {
    super(
      `Invalid state transition for ${instanceId}: ${from} → ${to}`,
      'INVALID_STATE_TRANSITION',
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class DockerError extends AgenticHostingError {
  constructor(message: string) {
    super(message, 'DOCKER_ERROR');
    this.name = 'DockerError';
  }
}

/**
 * Raised when a Docker daemon call exceeds its configured timeout.
 * Distinct from DockerError so callers can treat timeouts as retryable-with-backoff
 * while regular DockerErrors (4xx responses, semantic failures) are usually not.
 */
export class DockerTimeoutError extends AgenticHostingError {
  constructor(operation: string, timeoutMs: number) {
    super(`Docker operation "${operation}" timed out after ${timeoutMs}ms`, 'DOCKER_TIMEOUT');
    this.name = 'DockerTimeoutError';
  }
}

export class HelloTimeoutError extends AgenticHostingError {
  constructor(instanceId: string, timeoutMs: number) {
    super(
      `Tenant ${instanceId} did not send hello within ${timeoutMs}ms`,
      'HELLO_TIMEOUT',
    );
    this.name = 'HelloTimeoutError';
  }
}

export class DuplicateInstanceNameError extends AgenticHostingError {
  constructor(name: string) {
    super(`Instance name already in use: ${name}`, 'DUPLICATE_NAME');
    this.name = 'DuplicateInstanceNameError';
  }
}

export class TemplateConflictError extends AgenticHostingError {
  constructor(name: string, existingTemplate: string, requestedTemplate: string, existingState?: string) {
    const inProgress = existingState === 'BOOTING' || existingState === 'CREATED';
    const suffix = inProgress
      ? ` (existing spawn is still ${existingState} — race; retry after it settles)`
      : '';
    super(
      `Instance "${name}" exists with template "${existingTemplate}" but spawn requested template "${requestedTemplate}"${suffix}`,
      'TEMPLATE_CONFLICT',
    );
    this.name = 'TemplateConflictError';
  }
}

export class ConfigError extends AgenticHostingError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class PayloadValidationError extends AgenticHostingError {
  constructor(message: string) {
    super(message, 'INVALID_PAYLOAD');
    this.name = 'PayloadValidationError';
  }
}

export class SpawnAbortedError extends AgenticHostingError {
  constructor(instanceId: string) {
    super(`Spawn aborted for instance ${instanceId}: instance state changed`, 'SPAWN_ABORTED');
    this.name = 'SpawnAbortedError';
  }
}

export class ManagerDisposedError extends AgenticHostingError {
  constructor() {
    super('Manager disposed', 'MANAGER_DISPOSED');
    this.name = 'ManagerDisposedError';
  }
}

export class InstanceLockQueueFullError extends AgenticHostingError {
  constructor(instanceId: string, depth: number, cap: number) {
    super(
      `Instance lock queue depth ${depth} reached cap ${cap} for ${instanceId} — refusing new acquisition`,
      'INSTANCE_LOCK_QUEUE_FULL',
    );
    this.name = 'InstanceLockQueueFullError';
  }
}

/** Extract a human-readable message from an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown';
}
