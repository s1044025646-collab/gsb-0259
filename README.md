# 本地单调 ULID 生成与核验服务

这是一个只包含后端 API 与 CLI 的 Windows 本地项目，用 TypeScript、Node.js 和 SQLite 实现。它不包含账户、认证、分布式协调、全局时钟服务或前端页面。

## 环境要求

- Windows 本机环境。
- Node.js 22.5 或更高版本；本项目已在 Node.js `v25.5.0`、npm `11.8.0` 上验证。旧版本如未默认启用实验 SQLite，可用 `NODE_OPTIONS=--experimental-sqlite` 启动。
- 不需要 Docker、WSL、付费服务或外部在线 API。
- 运行时使用 Node 内置实验模块 `node:sqlite`，执行时会看到实验性警告。

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

`npm start` 等价于：

```powershell
node dist/cli.js serve --port 0 --host 127.0.0.1
```

默认端口是 `0`，操作系统会选择空闲端口；启动后命令行输出实际端口。默认数据库为项目内的 `data/ulid.sqlite`。

指定端口或数据库：

```powershell
node dist/cli.js serve --port 8787 --db data/dev.sqlite
```

## ULID 格式与单调性

ULID 总长度为 26 个 Crockford Base32 大写字符，共 128 位：

- 前 10 个字符：48 位无符号毫秒时间戳。
- 后 16 个字符：80 位无符号随机量。
- 输出统一规范为大写；解码接受小写并规范化。
- 字符集为 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`。
- 首字符大于 `7` 会使整体数值超过 128 位，接口明确拒绝。

同一生成器的推进规则：

1. 当前时间晚于上次时间戳：使用当前时间，并取 10 字节安全随机量。
2. 当前时间等于上次时间戳：保留时间戳，将上次 80 位随机量加一。
3. 检测到时钟回退：仍保留上次时间戳，将上次 80 位随机量加一。
4. 时间再次超过保留的时间戳后，才恢复使用系统时间和新随机量。
5. 保留毫秒内随机量达到 `2^80 - 1` 时拒绝本次生成，不回绕、不忙等、不伪造将来的系统时间。

不同命名生成器拥有独立状态。项目不宣称不同生成器之间存在全局单调性。`/inspect` 只检查调用方提交的一组字符串是否重复、是否按编码值严格递增；ULID 中不包含生成器名称，因此它不能证明这些值来自同一生成器。

## 持久化与并发

SQLite 中保存：

- 生成器元数据。
- 每个生成器最后一次成功发放的时间戳、随机量和 ULID。
- 每次成功发放的历史记录。

每次单条或批量申请使用 `BEGIN IMMEDIATE` 事务：

- 读取当前状态、推进单调状态、插入发放记录、更新最后状态在同一事务中完成。
- 批量生成中任何一条失败，整批回滚，不留下未说明的半批结果。
- 同一数据库的多个连接并发申请时由 SQLite 写锁串行化，唯一约束防止重复记录。
- 服务重启后从 `generator_state` 恢复并继续递增。

每批最多 100 条。检查接口一次最多接收 500 条。历史导出默认 1000 条，最大 10000 条。

## CLI

所有命令都可以追加 `--db data/ulid.sqlite` 指定数据库。

```powershell
node dist/cli.js create orders
node dist/cli.js generators
node dist/cli.js generator orders
node dist/cli.js issue orders
node dist/cli.js issue orders --count 10
node dist/cli.js decode 01ARZ3NDEKTSV4RRFFQ69G5FAV
node dist/cli.js inspect 01ARZ3NDEKTSV4RRFFQ69G5FAV 01ARZ3NDEKTSV4RRFFQ69G5FAW
node dist/cli.js history orders --limit 50
node dist/cli.js export orders --limit 1000
node dist/cli.js serve --port 0
```

批量大小必须是 1 到 100 的整数。

## HTTP API

服务默认监听 `127.0.0.1`。以下示例假设端口为 `8787`。

### 健康检查

```http
GET /health
```

### 创建生成器

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/generators `
  -ContentType 'application/json' `
  -Body '{"name":"orders"}'
```

生成器名称长度为 1 到 64，只能包含字母、数字、点、下划线和连字符，并且必须以字母或数字开头。重名返回 `CONFLICT`。

### 查询生成器

```http
GET /generators
GET /generators/orders
```

### 单条或批量生成

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/generators/orders/issue `
  -ContentType 'application/json' `
  -Body '{"count":10}'
```

`count` 可省略，省略时生成 1 条；超过 100 返回 `BATCH_TOO_LARGE`。

### 解码

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/decode `
  -ContentType 'application/json' `
  -Body '{"ulid":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}'
```

返回规范大写 ULID、原始毫秒时间戳、UTC 时间、80 位随机量十进制字符串和 16 字节十六进制表示。

### 检查重复和顺序

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/inspect `
  -ContentType 'application/json' `
  -Body '{"ulids":["...","..."]}'
```

### 历史与导出

```http
GET /generators/orders/history?limit=50
GET /generators/orders/history?limit=50&beforeSequence=120
GET /generators/orders/export?limit=1000
```

历史按发放顺序返回；接口内部以倒序读取限定范围后再按正序返回。导出始终从最早记录开始。

## 错误码

- `VALIDATION_ERROR`：参数格式错误。
- `NOT_FOUND`：生成器或接口不存在。
- `CONFLICT`：生成器重名。
- `INVALID_ULID`：长度、字符集、大小写规范化后的上界或位字段校验失败。
- `RANDOM_OVERFLOW`：同一保留毫秒内随机量已到最大值。
- `CLOCK_INVALID`：时间戳超出 48 位范围。
- `BATCH_TOO_LARGE`：批量数量超过 100。
- `DUPLICATE_ULID`：检查集合中存在重复。
- `SEQUENCE_DECREASED`：检查集合未严格递增。
- `DATABASE_BUSY`：SQLite 短暂锁定，可重试。
- `INTERNAL_ERROR`：未分类内部错误。

错误响应格式：

```json
{
  "error": {
    "code": "INVALID_ULID",
    "message": "ULID 首字符不能大于 7，否则数值超过 128 位上界"
  }
}
```

## 演示与测试时钟

运行：

```powershell
npm run demo
```

演示脚本会创建临时数据库，并向核心逻辑注入固定毫秒时钟和确定性随机源，用来展示：

- 同一固定毫秒连续生成。
- 随机部分逐次加一。
- 时钟向后跳时保留上次时间戳。
- 时间前进后使用新时间和新随机量。
- 关闭并重新打开数据库后继续递增。

演示时钟只用于测试和演示，不会修改 Windows 系统时间。生产服务默认使用 `Date.now()` 和 Web Crypto 的安全随机字节。

## 测试

```powershell
npm test
```

测试覆盖已知编码向量、最大时间戳、全零随机量、随机部分进位与溢出、非法字符、小写规范化、独立字节拼接、逐字符解码、批次事务回滚、重启恢复、不同生成器独立顺序，以及两个 SQLite 连接并发发放时的唯一性和持久化状态。

测试不会依赖大量随机抽样来“证明”不碰撞；并发测试使用两个真实数据库连接和数据库中的唯一约束验证结果。

## 项目结构

```text
src/
  ulid.ts      # BigInt 位字段、Crockford Base32、单调推进
  store.ts     # SQLite 表、事务、历史与导出
  inspect.ts   # 重复和顺序核验
  server.ts    # HTTP API
  cli.ts       # 命令行入口
  demo.ts      # 固定时钟演示
test/
  ulid.test.ts # Node 内置测试
data/          # 默认本地数据目录，运行时自动创建
```

## 已知限制

- `node:sqlite` 在当前 Node 版本仍会输出实验性警告；后续 Node 版本 API 可能调整。
- 单调性范围是单数据库内的单个命名生成器，不提供跨机器协调。
- 服务信任本机时钟；它能处理时钟回退，但不能解决恶意篡改系统时钟的问题。
- 达到单调随机量上界时请求失败，调用方应等待本机时间超过保留毫秒后重试；服务本身不会忙等。
