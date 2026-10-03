import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { ApiError, errorBody } from './errors.js';
import { inspectUlids } from './inspect.js';
import { UlidStore } from './store.js';
import { decodeUlid, secureRandomBytes, systemClock } from './ulid.js';

export interface CreateServerOptions {
  databasePath: string;
  store?: UlidStore;
}

export function createApiServer(options: CreateServerOptions): { server: Server; store: UlidStore } {
  const store = options.store ?? new UlidStore(options.databasePath);

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, store);
    } catch (error) {
      sendError(response, error);
    }
  });

  return { server, store };
}

export async function listenOnFreePort(server: Server, preferredPort = 0, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new ApiError('INTERNAL_ERROR', '无法读取服务监听地址', 500);
  }
  return address.port;
}

async function route(request: IncomingMessage, response: ServerResponse, store: UlidStore): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathParts = url.pathname.split('/').filter(Boolean);
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'generators') {
    sendJson(response, 200, { generators: store.listGenerators() });
    return;
  }
  if (method === 'POST' && pathParts.length === 1 && pathParts[0] === 'generators') {
    const body = await readJson(request);
    sendJson(response, 201, { generator: store.createGenerator(requireString(body.name, 'name')) });
    return;
  }
  if (method === 'POST' && pathParts[0] === 'generators' && pathParts[2] === 'issue') {
    const body = await readJson(request);
    const count = optionalInteger(body.count);
    const records = store.issue(decodeURIComponent(pathParts[1]!), systemClock(), secureRandomBytes, {
      ...(count === undefined ? {} : { count })
    });
    sendJson(response, 201, { items: records });
    return;
  }
  if (method === 'GET' && pathParts[0] === 'generators' && pathParts[2] === 'history') {
    const records = store.history(
      decodeURIComponent(pathParts[1]!),
      optionalInteger(url.searchParams.get('limit')) ?? 50,
      optionalInteger(url.searchParams.get('beforeSequence'))
    );
    sendJson(response, 200, { items: records });
    return;
  }
  if (method === 'GET' && pathParts[0] === 'generators' && pathParts[2] === 'export') {
    const records = store.exportRecords(
      decodeURIComponent(pathParts[1]!),
      optionalInteger(url.searchParams.get('limit')) ?? 1000
    );
    sendJson(response, 200, { items: records });
    return;
  }
  if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'generators') {
    sendJson(response, 200, { generator: store.getGenerator(decodeURIComponent(pathParts[1]!)) });
    return;
  }
  if (method === 'POST' && url.pathname === '/decode') {
    const body = await readJson(request);
    sendJson(response, 200, { decoded: decodeUlid(requireString(body.ulid, 'ulid')) });
    return;
  }
  if (method === 'POST' && url.pathname === '/inspect') {
    const body = await readJson(request);
    sendJson(response, 200, { result: inspectUlids(body.ulids) });
    return;
  }

  sendError(response, new ApiError('NOT_FOUND', '接口不存在', 404));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new ApiError('VALIDATION_ERROR', '请求体不能超过 1 MiB', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('VALIDATION_ERROR', '请求体必须是 JSON 对象');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendError(response: ServerResponse, error: unknown): void {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : '未知内部错误',
          500
        );
  sendJson(response, apiError.status, errorBody(apiError));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('VALIDATION_ERROR', `${field} 必须是非空字符串`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError('VALIDATION_ERROR', '该参数必须是整数');
  }
  return value;
}
