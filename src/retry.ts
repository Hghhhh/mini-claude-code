/**
 * mini-claude-code — 重试引擎
 * Day 10：指数退避 + 错误分类 + 模型降级
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fallbackModel?: string;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 32000,
};

export function getRetryDelay(attempt: number, opts: RetryOptions): number {
  const delay = Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
  const jitter = delay * 0.25 * Math.random();
  return delay + jitter;
}

export function isRetryableError(error: any): boolean {
  if (!error) return false;
  if (error.status === undefined) return true;
  if (error.status >= 500) return true;
  if (error.status === 529) return true;
  if (error.status === 429) return true;
  return false;
}

export function shouldFallback(error: any, consecutive529: number): boolean {
  return error.status === 529 && consecutive529 >= 3;
}

export class FallbackError extends Error {
  constructor(public fallbackModel: string) {
    super(`模型降级到 ${fallbackModel}`);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let consecutive529 = 0;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await fn();
      consecutive529 = 0;
      return result;
    } catch (error: any) {
      if (error.status === 529) consecutive529++;
      else consecutive529 = 0;

      if (options.fallbackModel && shouldFallback(error, consecutive529)) {
        throw new FallbackError(options.fallbackModel);
      }

      if (attempt >= options.maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delay = getRetryDelay(attempt, options);
      console.log(`  [重试] 第 ${attempt + 1} 次，等待 ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
