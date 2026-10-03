#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError, errorBody } from './errors.js';
import { inspectUlids } from './inspect.js';
import { createApiServer, listenOnFreePort } from './server.js';
import { UlidStore } from './store.js';
import { decodeUlid, secureRandomBytes, systemClock } from './ulid.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string>;
}

const args = parseArgs(process.argv.slice(2));
const dataPath = args.options.get('db') ?? resolve('data/ulid.sqlite');

try {
  if (args.command === 'serve') await serve(args);
  else runDirect(args);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(JSON.stringify(errorBody(error), null, 2));
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function runDirect(parsed: ParsedArgs): void {
  mkdirSync(dirname(dataPath), { recursive: true });
  const store = new UlidStore(dataPath);
  try {
    switch (parsed.command) {
      case 'create': {
        const name = requirePositional(parsed, 1);
        print({ generator: store.createGenerator(name) });
        break;
      }
      case 'issue': {
        const name = requirePositional(parsed, 1);
        const count = parseInteger(parsed.options.get('count'), 1);
        print({ items: store.issue(name, systemClock(), secureRandomBytes, { count }) });
        break;
      }
      case 'generator': {
        print({ generator: store.getGenerator(requirePositional(parsed, 1)) });
        break;
      }
      case 'generators': {
        print({ generators: store.listGenerators() });
        break;
      }
      case 'history': {
        const limit = parseInteger(parsed.options.get('limit'), 50);
        print({ items: store.history(requirePositional(parsed, 1), limit) });
        break;
      }
      case 'export': {
        const limit = parseInteger(parsed.options.get('limit'), 1000);
        print({ items: store.exportRecords(requirePositional(parsed, 1), limit) });
        break;
      }
      case 'decode': {
        print({ decoded: decodeUlid(requirePositional(parsed, 1)) });
        break;
      }
      case 'inspect': {
        const values = parsed.positional.length > 0 ? parsed.positional : readStdinLines();
        print({ result: inspectUlids(values) });
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

async function serve(parsed: ParsedArgs): Promise<void> {
  mkdirSync(dirname(dataPath), { recursive: true });
  const port = parseInteger(parsed.options.get('port'), 0);
  const host = parsed.options.get('host') ?? '127.0.0.1';
  const { server, store } = createApiServer({ databasePath: dataPath });
  const actualPort = await listenOnFreePort(server, port, host);
  const shutdown = () => {
    server.close(() => {
      store.close();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(JSON.stringify({ status: 'listening', host, port: actualPort, database: dataPath }, null, 2));
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith('--')) {
      const key = argument.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options.set(key, next);
        index += 1;
      } else {
        options.set(key, 'true');
      }
    } else if (positional.length === 0) {
      positional.push(argument);
    } else {
      positional.push(argument);
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), options };
}

function requirePositional(parsed: ParsedArgs, count: number): string {
  if (parsed.positional.length < count) {
    throw new ApiError('VALIDATION_ERROR', `命令缺少第 ${count} 个位置参数`);
  }
  return parsed.positional[count - 1]!;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new ApiError('VALIDATION_ERROR', `无效整数：${value}`);
  return number;
}

function readStdinLines(): string[] {
  const text = readFileSync(0, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`用法：
  node dist/cli.js create <生成器名> [--db data/ulid.sqlite]
  node dist/cli.js issue <生成器名> [--count 10]
  node dist/cli.js decode <ULID>
  node dist/cli.js inspect <ULID...>
  node dist/cli.js generators
  node dist/cli.js generator <生成器名>
  node dist/cli.js history <生成器名> [--limit 50]
  node dist/cli.js export <生成器名> [--limit 1000]
  node dist/cli.js serve [--port 0] [--host 127.0.0.1] [--db data/ulid.sqlite]`);
}
