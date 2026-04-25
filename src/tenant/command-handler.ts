/**
 * CommandHandler — handles ACP commands sent by the manager to the tenant.
 */

import type { AcpResultPayload, AcpErrorPayload } from '../protocols/acp.js';
import { LOG_LEVELS } from '../shared/types.js';
import type { LogLevel } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';
import { execFile } from 'node:child_process';

export interface CommandHandler {
  execute(commandName: string, params: Record<string, unknown>): Promise<AcpResultPayload | AcpErrorPayload>;
  isShutdownRequested(): boolean;
}

const MAX_CONCURRENT_EXEC = 5;

export function createCommandHandler(
  instanceId: string,
  instanceName: string,
  startedAt: number,
  logger: Logger,
  getAppState?: () => { message_count: number; last_activity_ms: number },
): CommandHandler {
  let shutdownRequested = false;
  let activeExecCount = 0;

  return {
    async execute(commandName: string, params: Record<string, unknown>): Promise<AcpResultPayload | AcpErrorPayload> {
      const commandId = typeof params['command_id'] === 'string' ? params['command_id'] : '';

      switch (commandName.toUpperCase()) {
        case 'STATUS': {
          const uptimeMs = Date.now() - startedAt;
          const appState = getAppState?.();
          logger.debug('command_status', { uptime_ms: uptimeMs });
          return {
            command_id: commandId,
            ok: true as const,
            result: {
              status: 'RUNNING',
              uptime_ms: uptimeMs,
              instance_id: instanceId,
              instance_name: instanceName,
              ...(appState && { message_count: appState.message_count, last_activity_ms: appState.last_activity_ms }),
            },
          };
        }

        case 'SHUTDOWN_GRACEFUL': {
          shutdownRequested = true;
          logger.info('shutdown_requested');
          return {
            command_id: commandId,
            ok: true,
            result: { acknowledged: true },
          };
        }

        case 'SET_LOG_LEVEL': {
          const level = params['level'];
          if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) {
            logger.warn('invalid_log_level', { level: String(level) });
            return {
              command_id: commandId,
              ok: false,
              error_code: 'INVALID_PARAM',
              message: `Invalid log level: ${String(level)}. Must be one of: ${LOG_LEVELS.join(', ')}`,
            };
          }
          logger.setLevel(level as LogLevel);
          logger.info('log_level_changed', { level });
          return {
            command_id: commandId,
            ok: true,
            result: { level },
          };
        }

        case 'EXEC': {
          const script = params['script'];
          if (typeof script !== 'string' || script === '') {
            return {
              command_id: commandId,
              ok: false,
              error_code: 'INVALID_PARAM',
              message: 'EXEC requires a non-empty string "script" parameter',
            };
          }
          // Enforce script length limit to prevent pathological inputs
          const MAX_SCRIPT_LENGTH = 65536;
          if (script.length > MAX_SCRIPT_LENGTH) {
            return {
              command_id: commandId,
              ok: false,
              error_code: 'INVALID_PARAM',
              message: `EXEC script exceeds maximum length of ${MAX_SCRIPT_LENGTH} characters`,
            };
          }
          // Prevent fork-bomb DoS via unbounded concurrent EXEC commands
          if (activeExecCount >= MAX_CONCURRENT_EXEC) {
            return {
              command_id: commandId,
              ok: false,
              error_code: 'EXEC_BUSY',
              message: `Max concurrent EXEC limit (${MAX_CONCURRENT_EXEC}) reached`,
            };
          }
          activeExecCount++;
          let execResult: { stdout: string; stderr: string; exit_code: number };
          try {
            // Note: execFile with /bin/sh -c is functionally equivalent to exec(). This is
            // intentional — EXEC provides full shell access within the tenant's Docker container.
            // The container sandbox is the security boundary, not the shell invocation.
            execResult = await new Promise<{ stdout: string; stderr: string; exit_code: number }>((resolve) => {
              execFile('/bin/sh', ['-c', script], {
                timeout: 30000,
                maxBuffer: 1024 * 1024, // 1MB per stream
                killSignal: 'SIGKILL', // Ensure process is killed on timeout (SIGTERM can be caught)
              }, (err, stdout, stderr) => {
                const rawCode = err && 'code' in err ? (err as { code?: unknown }).code : 0;
                const exitCode = typeof rawCode === 'number' ? rawCode : 1;
                resolve({
                  stdout: typeof stdout === 'string' ? stdout : '',
                  stderr: typeof stderr === 'string' ? stderr : '',
                  exit_code: exitCode,
                });
              });
            });
          } finally {
            activeExecCount--;
          }
          logger.debug('command_exec', { exit_code: execResult.exit_code });
          return {
            command_id: commandId,
            ok: true,
            result: execResult,
          };
        }

        default: {
          logger.warn('unknown_command', { command: commandName });
          return {
            command_id: commandId,
            ok: false,
            error_code: 'UNKNOWN_COMMAND',
            message: `Unknown command: ${commandName}`,
          };
        }
      }
    },

    isShutdownRequested(): boolean {
      return shutdownRequested;
    },
  };
}
