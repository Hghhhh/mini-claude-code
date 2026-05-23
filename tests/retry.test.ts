import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getRetryDelay,
  isRetryableError,
  shouldFallback,
  withRetry,
  FallbackError,
  RetryOptions,
} from "../src/retry";

describe("重试引擎", () => {
  describe("getRetryDelay", () => {
    const baseOpts: RetryOptions = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 32000,
    };

    it("第 0 次重试返回约 1000ms（加抖动）", () => {
      const delay = getRetryDelay(0, baseOpts);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1250); // 1000 + 25% jitter
    });

    it("指数退避：每次翻倍", () => {
      const d0 = getRetryDelay(0, baseOpts);
      const d1 = getRetryDelay(1, baseOpts);
      const d2 = getRetryDelay(2, baseOpts);
      // d1 基础值是 2000，d2 基础值是 4000
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
    });

    it("不超过 maxDelayMs 上限", () => {
      const delay = getRetryDelay(100, baseOpts);
      // 最大 32000 + 25% jitter = 40000
      expect(delay).toBeLessThanOrEqual(40000);
    });

    it("baseDelayMs=100 时第 0 次约 100ms", () => {
      const opts: RetryOptions = { ...baseOpts, baseDelayMs: 100 };
      const delay = getRetryDelay(0, opts);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(125);
    });

    it("抖动使相同参数产生不同结果", () => {
      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        delays.add(getRetryDelay(0, baseOpts));
      }
      // 20 次调用应该产生多个不同值（概率极高）
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe("isRetryableError", () => {
    it("null/undefined 不可重试", () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });

    it("网络错误（无 status）可重试", () => {
      expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
      expect(isRetryableError({ message: "network error" })).toBe(true);
    });

    it("529 过载可重试", () => {
      expect(isRetryableError({ status: 529 })).toBe(true);
    });

    it("429 限速可重试", () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it("500+ 服务器错误可重试", () => {
      expect(isRetryableError({ status: 500 })).toBe(true);
      expect(isRetryableError({ status: 502 })).toBe(true);
      expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it("400 客户端错误不可重试", () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it("401 认证错误不可重试", () => {
      expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it("413 请求太大不可重试", () => {
      expect(isRetryableError({ status: 413 })).toBe(false);
    });

    it("404 不可重试", () => {
      expect(isRetryableError({ status: 404 })).toBe(false);
    });
  });

  describe("shouldFallback", () => {
    it("连续 3 次 529 触发降级", () => {
      expect(shouldFallback({ status: 529 }, 3)).toBe(true);
    });

    it("连续 4 次 529 也触发降级", () => {
      expect(shouldFallback({ status: 529 }, 4)).toBe(true);
    });

    it("不足 3 次 529 不触发降级", () => {
      expect(shouldFallback({ status: 529 }, 2)).toBe(false);
      expect(shouldFallback({ status: 529 }, 1)).toBe(false);
      expect(shouldFallback({ status: 529 }, 0)).toBe(false);
    });

    it("非 529 错误不触发降级", () => {
      expect(shouldFallback({ status: 500 }, 3)).toBe(false);
      expect(shouldFallback({ status: 429 }, 5)).toBe(false);
    });
  });

  describe("FallbackError", () => {
    it("包含降级目标模型名", () => {
      const err = new FallbackError("claude-sonnet-4-20250514");
      expect(err.fallbackModel).toBe("claude-sonnet-4-20250514");
      expect(err.message).toContain("claude-sonnet-4-20250514");
    });

    it("是 Error 的子类", () => {
      const err = new FallbackError("test-model");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(FallbackError);
    });
  });

  describe("withRetry", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("成功时直接返回结果", async () => {
      const result = await withRetry(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
    });

    it("第一次失败、第二次成功时重试后返回", async () => {
      let attempt = 0;
      const result = await withRetry(
        () => {
          attempt++;
          if (attempt === 1) throw { status: 500, message: "server error" };
          return Promise.resolve("recovered");
        },
        { baseDelayMs: 1 }
      );
      expect(result).toBe("recovered");
      expect(attempt).toBe(2);
    });

    it("超过 maxRetries 后抛出最后的错误", async () => {
      const error = { status: 500, message: "persistent failure" };
      await expect(
        withRetry(() => Promise.reject(error), { maxRetries: 2, baseDelayMs: 1 })
      ).rejects.toBe(error);
    });

    it("不可重试的错误立即抛出，不重试", async () => {
      let attempts = 0;
      const error = { status: 400, message: "bad request" };
      await expect(
        withRetry(
          () => {
            attempts++;
            return Promise.reject(error);
          },
          { maxRetries: 3, baseDelayMs: 1 }
        )
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    });

    it("连续 3 次 529 + fallbackModel 触发 FallbackError", async () => {
      await expect(
        withRetry(() => Promise.reject({ status: 529 }), {
          maxRetries: 5,
          baseDelayMs: 1,
          fallbackModel: "claude-sonnet-4-20250514",
        })
      ).rejects.toBeInstanceOf(FallbackError);
    });

    it("529 不连续时不触发降级", async () => {
      let attempt = 0;
      await expect(
        withRetry(
          () => {
            attempt++;
            // 交替 529 和 500，打断连续 529 计数
            if (attempt % 2 === 1) throw { status: 529 };
            throw { status: 500 };
          },
          { maxRetries: 5, baseDelayMs: 1, fallbackModel: "sonnet" }
        )
      ).rejects.toEqual({ status: 500 });
    });

    it("无 fallbackModel 时 529 不触发降级，正常重试", async () => {
      await expect(
        withRetry(() => Promise.reject({ status: 529 }), {
          maxRetries: 2,
          baseDelayMs: 1,
          // 不设 fallbackModel
        })
      ).rejects.toEqual({ status: 529 });
    });

    it("成功后重置 529 计数", async () => {
      let attempt = 0;
      const result = await withRetry(
        () => {
          attempt++;
          if (attempt <= 2) throw { status: 529 };
          return Promise.resolve("ok");
        },
        { maxRetries: 5, baseDelayMs: 1, fallbackModel: "sonnet" }
      );
      expect(result).toBe("ok");
    });

    it("网络错误（无 status）可重试", async () => {
      let attempt = 0;
      const result = await withRetry(
        () => {
          attempt++;
          if (attempt === 1) throw new Error("ECONNRESET");
          return Promise.resolve("reconnected");
        },
        { baseDelayMs: 1 }
      );
      expect(result).toBe("reconnected");
    });

    it("maxRetries=0 时只执行一次", async () => {
      let attempts = 0;
      await expect(
        withRetry(
          () => {
            attempts++;
            return Promise.reject({ status: 500 });
          },
          { maxRetries: 0, baseDelayMs: 1 }
        )
      ).rejects.toEqual({ status: 500 });
      expect(attempts).toBe(1);
    });

    it("FallbackError 的 fallbackModel 字段正确传递", async () => {
      try {
        await withRetry(() => Promise.reject({ status: 529 }), {
          maxRetries: 5,
          baseDelayMs: 1,
          fallbackModel: "my-fallback-model",
        });
      } catch (e) {
        expect(e).toBeInstanceOf(FallbackError);
        expect((e as FallbackError).fallbackModel).toBe("my-fallback-model");
      }
    });
  });
});
