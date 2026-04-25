/**
 * High-level helpers for spawning, commanding, inspecting, and stopping
 * tenant agents via HMCP commands over the controller transport.
 *
 * All operations go through the HMCP protocol: controller DM → manager.
 * With real Sphere SDK and Nostr transport, tenant acp.hello arrives at
 * the manager and instances reach RUNNING.
 */

import { expect } from 'vitest';
import { createHmcpRequest } from '../../../src/protocols/hmcp.js';
import { serializeMessage } from '../../../src/protocols/envelope.js';
import type { LiveTestEnvironment, SpawnedAgent } from './environment.js';
import {
  HMCP_RESPONSE_TIMEOUT_MS,
  SPAWN_READY_TIMEOUT_MS,
  TRADE_OP_TIMEOUT_MS,
} from './constants.js';

// ---------------------------------------------------------------------------
// spawnAgent
// ---------------------------------------------------------------------------

/**
 * Send hm.spawn, wait for hm.spawn_ack + hm.spawn_ready (RUNNING).
 * Returns the agent identity from the spawn_ready response.
 *
 * The container boots from a real Docker image. The tenant sends acp.hello
 * over real Nostr relays to the manager, which completes the handshake
 * and marks the instance RUNNING.
 */
export async function spawnAgent(
  env: LiveTestEnvironment,
  templateId: string,
  instanceName: string,
): Promise<SpawnedAgent> {
  const req = createHmcpRequest('hm.spawn', {
    template_id: templateId,
    instance_name: instanceName,
  });

  await env.controllerTransport.sendDm(
    env.managerAddress,
    serializeMessage(req),
  );

  // Wait for spawn_ack (container created + starting)
  const ack = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.spawn_ack',
    HMCP_RESPONSE_TIMEOUT_MS,
  );
  const ackPayload = ack['payload'] as Record<string, unknown>;
  expect(ackPayload['accepted']).toBe(true);
  expect(ackPayload['instance_name']).toBe(instanceName);

  // Wait for spawn_ready (RUNNING — real ACP handshake completes over Nostr)
  const ready = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.spawn_ready',
    SPAWN_READY_TIMEOUT_MS,
  );
  const readyPayload = ready['payload'] as Record<string, unknown>;
  expect(readyPayload['state']).toBe('RUNNING');

  const agent: SpawnedAgent = {
    instanceId: readyPayload['instance_id'] as string,
    instanceName: readyPayload['instance_name'] as string,
    tenantPubkey: (readyPayload['tenant_pubkey'] as string) ?? '',
    tenantDirectAddress: (readyPayload['tenant_direct_address'] as string) ?? '',
    tenantNametag: (readyPayload['tenant_nametag'] as string) ?? null,
  };

  env.spawnedInstances.push(instanceName);
  return agent;
}

// ---------------------------------------------------------------------------
// sendCommand
// ---------------------------------------------------------------------------

/**
 * Send an ACP command via hm.command relay and return the result.
 * Works because the agent is RUNNING (real Nostr transport).
 */
export async function sendCommand(
  env: LiveTestEnvironment,
  instanceName: string,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = TRADE_OP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const req = createHmcpRequest('hm.command', {
    instance_name: instanceName,
    command,
    params,
  });

  await env.controllerTransport.sendDm(
    env.managerAddress,
    serializeMessage(req),
  );

  const response = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.command_result',
    timeoutMs,
  );

  const payload = response['payload'] as Record<string, unknown>;
  const acpResult = payload['result'] as Record<string, unknown>;

  // ACP result has { command_id, ok, result: {...} } — return the inner result
  // for convenience, but include ok/error fields at the top level for error checking.
  if (acpResult['ok'] === false) {
    return acpResult; // Error response — return as-is for error_code checking
  }
  const innerResult = acpResult['result'] as Record<string, unknown> | undefined;
  return innerResult ?? acpResult;
}

// ---------------------------------------------------------------------------
// verifyInstanceState
// ---------------------------------------------------------------------------

/**
 * Send hm.inspect and assert the instance is in the expected state.
 */
export async function verifyInstanceState(
  env: LiveTestEnvironment,
  instanceName: string,
  expectedState: string,
): Promise<void> {
  const req = createHmcpRequest('hm.inspect', {
    instance_name: instanceName,
  });

  await env.controllerTransport.sendDm(
    env.managerAddress,
    serializeMessage(req),
  );

  const response = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.inspect_result',
    HMCP_RESPONSE_TIMEOUT_MS,
  );

  const payload = response['payload'] as Record<string, unknown>;
  expect(payload['state']).toBe(expectedState);
}

// ---------------------------------------------------------------------------
// stopAgent
// ---------------------------------------------------------------------------

/**
 * Send hm.stop and wait for hm.stop_result confirming STOPPED state.
 */
export async function stopAgent(
  env: LiveTestEnvironment,
  instanceName: string,
): Promise<void> {
  const req = createHmcpRequest('hm.stop', {
    instance_name: instanceName,
  });

  await env.controllerTransport.sendDm(
    env.managerAddress,
    serializeMessage(req),
  );

  const response = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.stop_result',
    HMCP_RESPONSE_TIMEOUT_MS,
  );

  const payload = response['payload'] as Record<string, unknown>;
  expect(payload['state']).toBe('STOPPED');
}

// ---------------------------------------------------------------------------
// startAgent
// ---------------------------------------------------------------------------

/**
 * Send hm.start to a stopped instance. With real Nostr transport,
 * the new container completes the ACP handshake and reaches RUNNING.
 */
export async function startAgent(
  env: LiveTestEnvironment,
  instanceName: string,
): Promise<SpawnedAgent> {
  const req = createHmcpRequest('hm.start', {
    instance_name: instanceName,
  });

  await env.controllerTransport.sendDm(
    env.managerAddress,
    serializeMessage(req),
  );

  // Wait for start_ack
  const ack = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.start_ack',
    HMCP_RESPONSE_TIMEOUT_MS,
  );
  const ackPayload = ack['payload'] as Record<string, unknown>;
  expect(ackPayload['state']).toBe('BOOTING');

  // Wait for start_ready (RUNNING — real ACP handshake completes)
  const ready = await env.responses.waitForResponseType(
    req.msg_id,
    'hm.start_ready',
    SPAWN_READY_TIMEOUT_MS,
  );
  const readyPayload = ready['payload'] as Record<string, unknown>;
  expect(readyPayload['state']).toBe('RUNNING');

  return {
    instanceId: readyPayload['instance_id'] as string,
    instanceName: readyPayload['instance_name'] as string,
    tenantPubkey: (readyPayload['tenant_pubkey'] as string) ?? '',
    tenantDirectAddress: (readyPayload['tenant_direct_address'] as string) ?? '',
    tenantNametag: (readyPayload['tenant_nametag'] as string) ?? null,
  };
}

export type { SpawnedAgent } from './environment.js';
