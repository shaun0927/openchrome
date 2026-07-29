import {
  ProtocolError,
  Server,
  fromJsonSchema,
  inputRequired,
  type AuthInfo,
  type CallToolResult,
  type ClientCapabilities,
  type EmptyResult,
  type InputRequiredResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { Principal } from '../auth/api-key-types';
import { McpInputRequiredError, isMcpInputRequiredError } from '../errors/mcp-input-required';
import { PRINCIPAL_SYM } from '../middleware/auth';
import {
  generateRequestId,
  normalizeRequestId,
  runWithRequestContext,
  type RequestContext,
} from '../observability/request-id';
import type { MCPResponse } from '../types/mcp';
import type { TransportMessageContext } from '../transports';
import { getVersion } from '../version';

export const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';

const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const OPENCHROME_PRINCIPAL_KEY = 'openchromePrincipal';
const OPENCHROME_TRANSPORT_CONTEXT_KEY = 'openchromeTransportContext';

export type CoreMcpMessageHandler = (
  message: Record<string, unknown>,
  signal?: AbortSignal,
  context?: TransportMessageContext,
) => Promise<MCPResponse | null>;

export interface SdkAdapterOptions {
  era: 'legacy' | 'modern';
  /** Connection-scoped identifier retained only for the legacy protocol era. */
  mcpSessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sdkPrincipal(authInfo: AuthInfo | undefined): Principal | undefined {
  const value = authInfo?.extra?.[OPENCHROME_PRINCIPAL_KEY];
  if (!isRecord(value)) return undefined;
  if (typeof value.tenantId !== 'string' || !Array.isArray(value.scopes) || typeof value.mode !== 'string') {
    return undefined;
  }
  if (!value.scopes.every((scope) => typeof scope === 'string')) return undefined;
  if (!['disabled', 'legacy', 'api-key', 'jwt'].includes(value.mode)) return undefined;
  return value as unknown as Principal;
}

function sdkTransportContext(
  authInfo: AuthInfo | undefined,
): Pick<RequestContext, 'tenantId' | 'brokerClientId'> {
  const value = authInfo?.extra?.[OPENCHROME_TRANSPORT_CONTEXT_KEY];
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.tenantId === 'string' ? { tenantId: value.tenantId } : {}),
    ...(typeof value.brokerClientId === 'string'
      ? { brokerClientId: value.brokerClientId }
      : {}),
  };
}

export function toSdkAuthInfo(
  principal: Principal | undefined,
  transportContext: Pick<RequestContext, 'tenantId' | 'brokerClientId'> = {},
): AuthInfo | undefined {
  if (!principal) return undefined;
  return {
    // Authentication has already happened in OpenChrome's middleware. Never
    // duplicate the plaintext bearer/API key into the SDK context.
    token: 'openchrome-authenticated',
    clientId: principal.keyId ?? principal.tenantId,
    scopes: [...principal.scopes],
    extra: {
      [OPENCHROME_PRINCIPAL_KEY]: { ...principal, scopes: [...principal.scopes] },
      [OPENCHROME_TRANSPORT_CONTEXT_KEY]: transportContext,
    },
  };
}

function clientCapabilitiesFor(
  server: Server,
  ctx: ServerContext,
  era: 'legacy' | 'modern',
): ClientCapabilities | undefined {
  if (era === 'modern') {
    return (ctx.mcpReq.envelope as Record<string, unknown> | undefined)
      ?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  }
  return server.getClientCapabilities();
}

function clientInfoFor(
  server: Server,
  ctx: ServerContext,
  era: 'legacy' | 'modern',
): { name?: string; version?: string } | undefined {
  const raw = era === 'modern'
    ? (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_INFO_META_KEY]
    : server.getClientVersion();
  if (!isRecord(raw)) return undefined;
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
  };
}

function inputRequestFor(method: string, params?: Record<string, unknown>) {
  switch (method) {
    case 'sampling/createMessage':
      return inputRequired.createMessage((params ?? {}) as Parameters<typeof inputRequired.createMessage>[0]);
    case 'elicitation/create': {
      const message = typeof params?.message === 'string' ? params.message : 'OpenChrome requires user input.';
      if (params?.mode === 'url' && typeof params.url === 'string') {
        return inputRequired.elicitUrl({ message, url: params.url });
      }
      return inputRequired.elicit({
        message,
        requestedSchema: (params?.requestedSchema ?? {
          type: 'object',
          properties: {},
        }) as Parameters<typeof inputRequired.elicit>[0]['requestedSchema'],
      });
    }
    case 'roots/list':
      return inputRequired.listRoots();
    default:
      throw new ProtocolError(-32601, `Unsupported input request method: ${method}`);
  }
}

function requestClientFor(
  ctx: ServerContext,
  era: 'legacy' | 'modern',
): NonNullable<RequestContext['requestClient']> {
  let ordinal = 0;
  return async <T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> => {
    if (era === 'legacy') {
      const requestOptions = {
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.signal !== undefined ? { requestSignal: options.signal } : {}),
      };
      switch (method) {
        case 'sampling/createMessage':
          return await ctx.mcpReq.send(
            { method, params: params ?? {} },
            requestOptions,
          ) as T;
        case 'elicitation/create':
          return await ctx.mcpReq.send(
            { method, params: params ?? {} },
            requestOptions,
          ) as T;
        case 'roots/list':
          return await ctx.mcpReq.send(
            { method, ...(params ? { params } : {}) },
            requestOptions,
          ) as T;
        default:
          throw new ProtocolError(-32601, `Unsupported client request method: ${method}`);
      }
    }

    ordinal++;
    const key = `openchrome_${ordinal}_${method.replace(/[^A-Za-z0-9]+/g, '_')}`;
    if (
      ctx.mcpReq.inputResponses &&
      Object.prototype.hasOwnProperty.call(ctx.mcpReq.inputResponses, key)
    ) {
      return ctx.mcpReq.inputResponses[key] as T;
    }

    throw new McpInputRequiredError(inputRequired({
      inputRequests: { [key]: inputRequestFor(method, params) },
    }));
  };
}

function legacyServerRequestClient(
  server: Server,
): NonNullable<RequestContext['requestClient']> {
  return async <T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> => {
    const requestOptions = {
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    };
    switch (method) {
      case 'sampling/createMessage':
        return await server.createMessage(
          (params ?? {}) as Parameters<typeof server.createMessage>[0],
          requestOptions,
        ) as T;
      case 'elicitation/create':
        return await server.elicitInput(
          (params ?? {}) as Parameters<typeof server.elicitInput>[0],
          requestOptions,
        ) as T;
      case 'roots/list':
        return await server.listRoots(
          params as Parameters<typeof server.listRoots>[0],
          requestOptions,
        ) as T;
      default:
        throw new ProtocolError(-32601, `Unsupported client request method: ${method}`);
    }
  };
}

function paramsWithMeta(
  params: unknown,
  ctx: ServerContext,
): Record<string, unknown> | undefined {
  const normalized = isRecord(params) ? { ...params } : {};
  if (ctx.mcpReq._meta && Object.keys(ctx.mcpReq._meta).length > 0) {
    normalized._meta = ctx.mcpReq._meta;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function requestIdFor(ctx: ServerContext): string {
  const header = ctx.http?.req?.headers.get('x-request-id');
  return normalizeRequestId(header) ?? generateRequestId();
}

/**
 * Adapt OpenChrome's mature tool/runtime core to the official MCP SDK wire
 * boundary. The SDK owns negotiation, envelopes, result discrimination,
 * standard HTTP headers, subscriptions, and protocol-era validation.
 */
export function createSdkServerAdapter(
  messageHandler: CoreMcpMessageHandler,
  options: SdkAdapterOptions,
): Server {
  const server = new Server(
    { name: 'openchrome', version: getVersion() },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        // Legacy clients can still use logging/setLevel. On modern requests
        // the SDK applies io.modelcontextprotocol/logLevel per request and
        // suppresses messages when it is absent.
        logging: {},
      },
      instructions:
        'Control Chrome with explicit OpenChrome sessionId and tabId handles. ' +
        'Use tools/list for the available browser operations and resources/list for live state.',
      cacheHints: {
        'server/discover': { ttlMs: 300_000, cacheScope: 'public' },
        'tools/list': { ttlMs: 30_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 0, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 60_000, cacheScope: 'private' },
        'resources/read': { ttlMs: 0, cacheScope: 'private' },
      },
    },
  );

  const dispatch = async (
    method: string,
    params: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): Promise<Record<string, unknown>> => {
    const principal = sdkPrincipal(ctx.http?.authInfo);
    const inheritedTransportContext = sdkTransportContext(ctx.http?.authInfo);
    const tenantId = principal?.mode === 'api-key' || principal?.mode === 'jwt'
      ? principal.tenantId
      : inheritedTransportContext.tenantId ?? principal?.tenantId;
    const capabilities = clientCapabilitiesFor(server, ctx, options.era);
    const clientInfo = clientInfoFor(server, ctx, options.era);
    const transportContext: TransportMessageContext = {
      ...(options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(inheritedTransportContext.brokerClientId
        ? { brokerClientId: inheritedTransportContext.brokerClientId }
        : {}),
    };
    const requestContext: RequestContext = {
      requestId: requestIdFor(ctx),
      ...(tenantId ? { tenantId } : {}),
      ...(principal?.keyId ? { keyId: principal.keyId } : {}),
      ...(options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : {}),
      ...(inheritedTransportContext.brokerClientId
        ? { brokerClientId: inheritedTransportContext.brokerClientId }
        : {}),
      protocolEra: options.era,
      ...(clientInfo ? { clientInfo } : {}),
      ...(capabilities
        ? { clientCapabilities: capabilities as RequestContext['clientCapabilities'] }
        : {}),
      requestClient: requestClientFor(ctx, options.era),
      notifyClient: async (notificationMethod, notificationParams) => {
        await ctx.mcpReq.notify({
          method: notificationMethod,
          ...(notificationParams ? { params: notificationParams } : {}),
        });
      },
      logClient: async (level, logger, data) => {
        await ctx.mcpReq.log(
          level as Parameters<typeof ctx.mcpReq.log>[0],
          data,
          logger,
        );
      },
    };

    const message: Record<PropertyKey, unknown> = {
      jsonrpc: '2.0',
      ...(ctx.mcpReq.id !== undefined ? { id: ctx.mcpReq.id } : {}),
      method,
      ...(params ? { params } : {}),
    };
    if (principal) {
      message[PRINCIPAL_SYM] = principal;
    }

    const response = await runWithRequestContext(
      requestContext,
      () => messageHandler(
        message as Record<string, unknown>,
        ctx.mcpReq.signal,
        transportContext,
      ),
    );
    if (response === null) return {};
    if (response.error) {
      throw new ProtocolError(response.error.code, response.error.message, response.error.data);
    }
    return (response.result ?? {}) as Record<string, unknown>;
  };

  const legacyNotificationContext = (): RequestContext => ({
    requestId: generateRequestId(),
    ...(options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : {}),
    protocolEra: 'legacy',
    ...(server.getClientCapabilities()
      ? { clientCapabilities: server.getClientCapabilities() as RequestContext['clientCapabilities'] }
      : {}),
    ...(server.getClientVersion()
      ? { clientInfo: server.getClientVersion() }
      : {}),
    requestClient: legacyServerRequestClient(server),
  });

  const dispatchLegacyNotification = async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> => {
    await runWithRequestContext(
      legacyNotificationContext(),
      () => messageHandler(
        {
          jsonrpc: '2.0',
          method,
          ...(params ? { params } : {}),
        },
        undefined,
        options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : undefined,
      ),
    );
  };

  server.setRequestHandler('tools/list', async (request, ctx) =>
    await dispatch('tools/list', paramsWithMeta(request.params, ctx), ctx) as unknown as ListToolsResult,
  );

  server.setRequestHandler('tools/call', async (request, ctx) => {
    try {
      const result = await dispatch(
        'tools/call',
        paramsWithMeta(request.params, ctx),
        ctx,
      ) as unknown as CallToolResult;
      return server.projectCallToolResult(result, undefined);
    } catch (error) {
      if (isMcpInputRequiredError(error)) {
        return error.result as InputRequiredResult;
      }
      throw error;
    }
  });

  server.setRequestHandler('resources/list', async (request, ctx) =>
    await dispatch('resources/list', paramsWithMeta(request.params, ctx), ctx) as unknown as ListResourcesResult,
  );
  server.setRequestHandler('resources/templates/list', async (request, ctx) =>
    await dispatch(
      'resources/templates/list',
      paramsWithMeta(request.params, ctx),
      ctx,
    ) as unknown as ListResourceTemplatesResult,
  );
  server.setRequestHandler('resources/read', async (request, ctx) =>
    await dispatch('resources/read', paramsWithMeta(request.params, ctx), ctx) as unknown as ReadResourceResult,
  );
  if (options.era === 'legacy') {
    server.setRequestHandler('resources/subscribe', async (request, ctx) =>
      await dispatch(
        'resources/subscribe',
        paramsWithMeta(request.params, ctx),
        ctx,
      ) as unknown as EmptyResult,
    );
    server.setRequestHandler('resources/unsubscribe', async (request, ctx) =>
      await dispatch(
        'resources/unsubscribe',
        paramsWithMeta(request.params, ctx),
        ctx,
      ) as unknown as EmptyResult,
    );
    server.setNotificationHandler(
      'notifications/roots/list_changed',
      async (notification) => {
        await dispatchLegacyNotification(
          'notifications/roots/list_changed',
          notification.params,
        );
      },
    );
  }

  // OpenChrome's explicit browser-session methods predate the modern MCP
  // transport session removal and remain useful application-level extensions.
  const extensionParams = fromJsonSchema<Record<string, unknown>>({});
  for (const method of ['sessions/list', 'sessions/create', 'sessions/delete'] as const) {
    server.setRequestHandler(
      method,
      { params: extensionParams },
      async (params, ctx) => await dispatch(method, paramsWithMeta(params, ctx), ctx),
    );
  }

  server.oninitialized = () => {
    void dispatchLegacyNotification('notifications/initialized').catch((error) => {
      console.error('[MCP SDK adapter] initialized notification failed:', error);
    });
  };

  return server;
}
