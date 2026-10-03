/**
 * 纯 Node.js HTTP API（无第三方框架）。
 * 端口可用 PORT 环境变量配置；默认自动选择空闲端口。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { net } from "node:util";
import { resolve } from "node:path";
import { openDatabase } from "./store.ts";
import { UlidService, ServiceError, MAX_BATCH_SIZE } from "./service.ts";
import { UlidError } from "./ulid.ts";

const DATA_DIR = resolve(process.cwd(), process.env.ULID_DATA_DIR ?? "data");
const DB_FILE = resolve(DATA_DIR, process.env.ULID_DB_FILE ?? "ulid.sqlite");

type Json = unknown;

function send(res: ServerResponse, status: number, body: Json) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_048_576) {
      throw new ServiceError("PAYLOAD_TOO_LARGE", "请求体超过 1 MiB", 413);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new ServiceError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

export function createApp(service: UlidService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    try {
      // 健康检查
      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, service: "monotonic-ulid", time: new Date().toISOString() });
      }

      // 生成器管理
      if (method === "GET" && path === "/api/generators") {
        return send(res, 200, { generators: service.listGenerators() });
      }
      if (method === "POST" && path === "/api/generators") {
        const body = await readJson(req);
        const row = service.createGenerator(String(body?.name ?? ""));
        return send(res, 201, { generator: service.listGenerators().find((g) => g.name === row.name) });
      }

      const genMatch = /^\/api\/generators\/([^/]+)$/.exec(path);
      if (method === "GET" && genMatch) {
        return send(res, 200, {
          generator: (() => {
            const row = service.getGenerator(decodeURIComponent(genMatch[1]!));
            return {
              name: row.name,
              lastTimestampMs: row.last_timestamp_ms,
              lastTimestampISO:
                row.last_timestamp_ms >= 0 ? new Date(row.last_timestamp_ms).toISOString() : null,
              lastRandom: row.last_random,
              lastUlid: row.last_ulid,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
          })(),
        });
      }

      // 生成
      const genPost = /^\/api\/generators\/([^/]+)\/ulids$/.exec(path);
      if (method === "POST" && genPost) {
        const name = decodeURIComponent(genPost[1]!);
        const body = await readJson(req);
        const count = body?.count === undefined ? 1 : Number(body.count);
        const ulids = service.generate(name, count);
        return send(res, 201, { generator: name, count: ulids.length, ulids });
      }

      // 历史
      const historyMatch = /^\/api\/generators\/([^/]+)\/history$/.exec(path);
      if (method === "GET" && historyMatch) {
        const name = decodeURIComponent(historyMatch[1]!);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return send(res, 200, service.history(name, limit, offset));
      }

      // 导出
      const exportMatch = /^\/api\/generators\/([^/]+)\/export$/.exec(path);
      if (method === "GET" && exportMatch) {
        const name = decodeURIComponent(exportMatch[1]!);
        return send(res, 200, { generator: name, records: service.export(name) });
      }

      // 解码
      if (method === "POST" && path === "/api/decode") {
        const body = await readJson(req);
        return send(res, 200, service.decode(String(body?.ulid ?? "")));
      }

      // 核验
      if (method === "POST" && path === "/api/check") {
        const body = await readJson(req);
        const ulids = Array.isArray(body?.ulids)
          ? body.ulids.map((x: unknown) => String(x))
          : [];
        return send(res, 200, service.check(ulids));
      }

      return send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由：${method} ${path}` } });
    } catch (err) {
      if (err instanceof ServiceError) {
        return send(res, err.status, { error: { code: err.code, message: err.message }, maxBatchSize: err.code === "BATCH_TOO_LARGE" ? MAX_BATCH_SIZE : undefined });
      }
      if (err instanceof UlidError) {
        return send(res, 422, { error: { code: err.code, message: err.message } });
      }
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 500, { error: { code: "INTERNAL", message } });
    }
  };
}

/** 查找空闲 TCP 端口 */
async function findFreePort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolvePort, rejectPort) => {
      const tester = net.createServer();
      tester.once("error", rejectPort);
      tester.listen(port, () => {
        tester.close(() => resolvePort(port));
      });
    });
  if (preferred && preferred > 0) {
    try {
      return await tryPort(preferred);
    } catch {
      // 指定端口被占用则回退到随机空闲端口
    }
  }
  return tryPort(0);
}

export async function startServer(dbFile = DB_FILE): Promise<{ server: Server; port: number }> {
  const db = openDatabase(dbFile);
  const service = new UlidService(db);
  const server = createServer(createApp(service));
  const preferredPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = await findFreePort(preferredPort);
  await new Promise<void>((resolvePort) => server.listen(port, resolvePort));
  return { server, port };
}

if (import.meta.url === `file:///${process.argv[1]!.replace(/\\/g, "/")}`) {
  startServer().then(({ port }) => {
    console.log(`[ulid] 数据库: ${DB_FILE}`);
    console.log(`[ulid] HTTP 服务已启动: http://127.0.0.1:${port}`);
    console.log("[ulid] 示例: GET /health, POST /api/generators {\"name\":\"orders\"}");
  });
}
