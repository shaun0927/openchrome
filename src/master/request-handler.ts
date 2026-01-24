/**
 * Request Handler - Routes IPC requests to session registry methods
 */

import { SessionRegistry } from './session-registry';
import { IPCServer } from './ipc-server';
import { IPCRequest, IPCResponse, IPCErrorCodes } from '../shared/ipc-protocol';

export class RequestHandler {
  constructor(
    private registry: SessionRegistry,
    private server: IPCServer
  ) {
    this.server.on('request', (request) => this.handleRequest(request));
    this.server.on('disconnect', (workerId) => this.handleWorkerDisconnect(workerId));
  }

  private async handleRequest(request: IPCRequest): Promise<void> {
    const { id, method, params, workerId } = request;

    try {
      const result = await this.dispatch(method, params, workerId);
      this.sendResponse(workerId, { id, result });
    } catch (error) {
      console.error(`[RequestHandler] Error handling ${method}:`, error);
      this.sendError(workerId, id, error as Error);
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    workerId: string
  ): Promise<unknown> {
    switch (method) {
      // Session management
      case 'session/create':
        return this.registry.createSession(workerId, params as { name?: string });

      case 'session/get':
        return this.registry.getSession(params.sessionId as string);

      case 'session/list':
        return this.registry.listSessions();

      case 'session/delete':
        await this.registry.deleteSession(params.sessionId as string);
        return { success: true };

      // Tab management
      case 'tabs/create':
        return this.registry.createTarget(
          params.sessionId as string,
          params.url as string | undefined
        );

      case 'tabs/list':
        return this.registry.listTargets(params.sessionId as string);

      case 'tabs/close':
        await this.registry.closeTarget(
          params.sessionId as string,
          params.targetId as string
        );
        return { success: true };

      // Page operations
      case 'page/navigate':
        await this.registry.navigate(
          params.sessionId as string,
          params.targetId as string,
          params.url as string,
          params.options as { waitUntil?: string; timeout?: number }
        );
        return { success: true };

      case 'page/screenshot':
        return this.registry.screenshot(
          params.sessionId as string,
          params.targetId as string,
          params.options as { format?: string; quality?: number; fullPage?: boolean }
        );

      case 'page/evaluate':
        return this.registry.evaluate(
          params.sessionId as string,
          params.targetId as string,
          params.script as string
        );

      case 'page/click':
        await this.registry.click(
          params.sessionId as string,
          params.targetId as string,
          params.x as number,
          params.y as number
        );
        return { success: true };

      case 'page/type':
        await this.registry.type(
          params.sessionId as string,
          params.targetId as string,
          params.text as string
        );
        return { success: true };

      case 'page/scroll':
        await this.registry.scroll(
          params.sessionId as string,
          params.targetId as string,
          params.x as number,
          params.y as number,
          params.direction as string,
          params.amount as number
        );
        return { success: true };

      // CDP execution
      case 'cdp/execute':
        return this.registry.executeCDP(
          params.sessionId as string,
          params.targetId as string,
          params.method as string,
          params.params as Record<string, unknown>
        );

      // Accessibility
      case 'page/getAccessibilityTree':
        return this.registry.getAccessibilityTree(
          params.sessionId as string,
          params.targetId as string
        );

      // Reference management
      case 'refs/set': {
        const nodeInfo = params.nodeInfo as { role: string; name: string } | undefined;
        const refId = this.registry.getRefIdManager().generateRef(
          params.sessionId as string,
          params.targetId as string,
          params.backendNodeId as number,
          nodeInfo?.role || 'unknown',
          nodeInfo?.name
        );
        return { success: true, refId };
      }

      case 'refs/get':
        return this.registry.getRefIdManager().getRef(
          params.sessionId as string,
          params.targetId as string,
          params.refId as string
        );

      case 'refs/clear':
        if (params.targetId) {
          this.registry.getRefIdManager().clearTargetRefs(
            params.sessionId as string,
            params.targetId as string
          );
        } else {
          this.registry.getRefIdManager().clearSessionRefs(params.sessionId as string);
        }
        return { success: true };

      // Worker management
      case 'worker/register':
        return { workerId, status: 'registered' };

      case 'worker/heartbeat':
        return { status: 'alive', timestamp: Date.now() };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private sendResponse(workerId: string, response: IPCResponse): void {
    this.server.sendToWorker(workerId, response);
  }

  private sendError(workerId: string, id: string, error: Error): void {
    const errorCode = this.getErrorCode(error);

    this.server.sendToWorker(workerId, {
      id,
      error: {
        code: errorCode,
        message: error.message,
      },
    });
  }

  private getErrorCode(error: Error): number {
    const message = error.message.toLowerCase();

    if (message.includes('session') && message.includes('not found')) {
      return IPCErrorCodes.SESSION_NOT_FOUND;
    }
    if (message.includes('target') || message.includes('page not found')) {
      return IPCErrorCodes.TARGET_NOT_FOUND;
    }
    if (message.includes('does not belong') || message.includes('ownership')) {
      return IPCErrorCodes.OWNERSHIP_VIOLATION;
    }
    if (message.includes('not connected')) {
      return IPCErrorCodes.CHROME_NOT_CONNECTED;
    }
    if (message.includes('timeout')) {
      return IPCErrorCodes.TIMEOUT;
    }

    return IPCErrorCodes.INTERNAL_ERROR;
  }

  private async handleWorkerDisconnect(workerId: string): Promise<void> {
    console.error(`[RequestHandler] Worker disconnected: ${workerId}`);
    await this.registry.cleanupWorker(workerId);
  }
}
