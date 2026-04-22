import Groq from "groq-sdk";

const RATE_WINDOW_MS = 60 * 1000;
const MAX_CALLS_PER_WINDOW = Number(process.env.AI_MAX_CALLS_PER_MIN || 40);
const MIN_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 5000;
const inFlightLocks = new Set();
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
const MAX_PROMPT_CHARS = Number(process.env.AI_MAX_PROMPT_CHARS || 8000);

const aiTelemetry = {
  totalCalls: 0,
  successCalls: 0,
  failedCalls: 0,
  rateLimitedCalls: 0,
  retryCount: 0,
  blockedByLocalGuard: 0,
  skippedByLock: 0,
  fallbackCount: 0,
  totalLatencyMs: 0,
  windowCalls: [],
  lastError: null,
  updatedAt: null,
};

const clampRetryDelayMs = (valueMs) =>
  Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(MIN_RETRY_DELAY_MS, Number(valueMs) || 0),
  );

const compactPrompt = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROMPT_CHARS);

const createTimeoutError = (timeoutMs) => {
  const err = new Error(`AI request timed out after ${timeoutMs}ms.`);
  err.response = {
    status: 504,
    data: {
      error: {
        message: err.message,
      },
    },
  };
  return err;
};

const withTimeout = (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        reject(createTimeoutError(timeoutMs));
      }, timeoutMs);
    }),
  ]);

const sanitizeEnvValue = (value) =>
  String(value || "")
    .trim()
    .replace(/^['\"]|['\"]$/g, "");

const resolveAiApiKey = () => sanitizeEnvValue(process.env.GROQ_API_KEY);

const resolveModel = () =>
  sanitizeEnvValue(process.env.GROQ_MODEL) || DEFAULT_GROQ_MODEL;

export function hasAiClientConfig() {
  return Boolean(resolveAiApiKey());
}

const createRequestInFlightError = (lockKey) => {
  const err = new Error(
    `AI request already in progress for lock "${lockKey}".`,
  );
  err.code = "AI_REQUEST_IN_PROGRESS";
  err.response = {
    status: 409,
    data: {
      error: {
        message: "Skipped duplicate AI request because one is already running.",
      },
    },
  };
  return err;
};

const createLocalRateLimitError = (retryAfterMs) => {
  const err = new Error(
    "Local AI rate guard active to protect free-tier quota.",
  );
  err.response = {
    status: 429,
    data: {
      error: {
        message: `Local AI guard: retry in ${Math.ceil(retryAfterMs / 1000)}s`,
      },
    },
    headers: {
      "retry-after": String(Math.ceil(retryAfterMs / 1000)),
    },
  };
  return err;
};

const cleanupWindowCalls = () => {
  const now = Date.now();
  aiTelemetry.windowCalls = aiTelemetry.windowCalls.filter(
    (ts) => now - ts < RATE_WINDOW_MS,
  );
};

const checkLocalRateGuard = () => {
  cleanupWindowCalls();
  const now = Date.now();
  if (aiTelemetry.windowCalls.length < MAX_CALLS_PER_WINDOW) {
    aiTelemetry.windowCalls.push(now);
    return null;
  }

  const oldest = aiTelemetry.windowCalls[0];
  const retryAfterMs = Math.max(1000, RATE_WINDOW_MS - (now - oldest));
  aiTelemetry.blockedByLocalGuard += 1;
  return createLocalRateLimitError(retryAfterMs);
};

const logAiEvent = (label, payload = {}) => {
  console.info(`[AI][${label}]`, payload);
};

export function recordAiFallback(context = "unknown") {
  aiTelemetry.fallbackCount += 1;
  aiTelemetry.updatedAt = new Date().toISOString();
  logAiEvent("fallback", { context, fallbackCount: aiTelemetry.fallbackCount });
}

export function getAiTelemetrySnapshot() {
  cleanupWindowCalls();
  const avgLatencyMs =
    aiTelemetry.successCalls > 0
      ? Number(
          (aiTelemetry.totalLatencyMs / aiTelemetry.successCalls).toFixed(1),
        )
      : 0;

  return {
    ...aiTelemetry,
    callsInCurrentWindow: aiTelemetry.windowCalls.length,
    maxCallsPerWindow: MAX_CALLS_PER_WINDOW,
    avgLatencyMs,
  };
}

export function getRetryAfterMs(err) {
  const headerRetry =
    err?.response?.headers?.["retry-after"] || err?.headers?.["retry-after"];
  if (headerRetry) {
    const asNumber = Number(headerRetry);
    if (!Number.isNaN(asNumber)) {
      return clampRetryDelayMs(asNumber * 1000);
    }
  }

  const message = err?.response?.data?.error?.message || err?.message || "";
  const match = message.match(/retry in\s*([\d.]+)s/i);
  if (match?.[1]) {
    const seconds = Number(match[1]);
    if (!Number.isNaN(seconds)) {
      return clampRetryDelayMs(Math.ceil(seconds * 1000));
    }
  }

  return MAX_RETRY_DELAY_MS;
}

export function isGeminiRateLimited(err) {
  return err?.response?.status === 429 || err?.status === 429;
}

export async function callGemini(prompt, options = {}) {
  const apiKey = resolveAiApiKey();
  const model = resolveModel();

  if (!apiKey) {
    throw new Error(
      "AI configuration missing. Please set GROQ_API_KEY in /server/.env",
    );
  }
  const groq = new Groq({ apiKey });

  const maxRetries = Math.max(0, Math.min(1, Number(options.maxRetries ?? 1)));
  const baseDelayMs = clampRetryDelayMs(
    options.baseDelayMs ?? MIN_RETRY_DELAY_MS,
  );
  const context = options.context || "generic";
  const lockKey = String(options.lockKey || context);
  const lockEnabled = options.lockEnabled !== false;
  const normalizedPrompt = compactPrompt(prompt);
  const promptLength = normalizedPrompt.length;
  const timeoutMs = Number(options.timeoutMs) || 15000;
  let attempt = 0;
  let lastError;

  if (lockEnabled && inFlightLocks.has(lockKey)) {
    aiTelemetry.skippedByLock += 1;
    aiTelemetry.updatedAt = new Date().toISOString();
    logAiEvent("skip", {
      context,
      lockKey,
      reason: "in-flight-lock",
      promptLength,
    });
    throw createRequestInFlightError(lockKey);
  }

  if (lockEnabled) {
    inFlightLocks.add(lockKey);
  }

  try {
    const guardError = checkLocalRateGuard();
    if (guardError) {
      aiTelemetry.totalCalls += 1;
      aiTelemetry.rateLimitedCalls += 1;
      aiTelemetry.updatedAt = new Date().toISOString();
      logAiEvent("blocked", {
        context,
        reason: "local-guard",
        promptLength,
        retryAfterMs: getRetryAfterMs(guardError),
      });
      throw guardError;
    }

    aiTelemetry.totalCalls += 1;
    aiTelemetry.updatedAt = new Date().toISOString();
    const startedAt = Date.now();
    logAiEvent("request", {
      context,
      lockKey,
      provider: "groq",
      model,
      promptLength,
      maxRetries,
      timeoutMs,
    });

    while (attempt <= maxRetries) {
      try {
        const response = await withTimeout(
          groq.chat.completions.create({
            model,
            temperature: 0.3,
            max_tokens: 2048,
            messages: [
              {
                role: "user",
                content: normalizedPrompt,
              },
            ],
          }),
          timeoutMs,
        );

        const text = response?.choices?.[0]?.message?.content || "";

        const latencyMs = Date.now() - startedAt;
        aiTelemetry.successCalls += 1;
        aiTelemetry.totalLatencyMs += latencyMs;
        aiTelemetry.updatedAt = new Date().toISOString();
        logAiEvent("response", {
          context,
          attempt,
          status: 200,
          latencyMs,
          responseLength: text.length,
        });

        return text;
      } catch (err) {
        lastError = err;
        const status = err?.response?.status || err?.status;

        aiTelemetry.lastError = {
          context,
          status,
          message: err?.message || "Unknown AI error",
          at: new Date().toISOString(),
        };

        if (status === 429) {
          aiTelemetry.rateLimitedCalls += 1;
        }

        if (status === 429 || (status >= 500 && status < 600)) {
          attempt += 1;
          if (attempt > maxRetries) break;
          aiTelemetry.retryCount += 1;
          const delayMs =
            status === 429
              ? clampRetryDelayMs(getRetryAfterMs(err))
              : clampRetryDelayMs(baseDelayMs * attempt);
          logAiEvent("retry", {
            context,
            attempt,
            status,
            delayMs,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        break;
      }
    }

    if (lastError && isGeminiRateLimited(lastError)) {
      lastError.retryAfterMs = getRetryAfterMs(lastError);
    }

    aiTelemetry.failedCalls += 1;
    aiTelemetry.updatedAt = new Date().toISOString();
    logAiEvent("error", {
      context,
      provider: "groq",
      model,
      status: lastError?.response?.status,
      retryAfterMs: lastError?.retryAfterMs || getRetryAfterMs(lastError),
      message: lastError?.message || "Unknown AI error",
    });

    throw lastError || new Error("Unknown AI error");
  } finally {
    if (lockEnabled) {
      inFlightLocks.delete(lockKey);
    }
  }
}

export function safeParseJson(text, fallback = {}) {
  if (!text || typeof text !== "string") return fallback;

  const direct = text.trim();

  // Strip fenced markdown wrappers if present.
  const fencedMatch = direct.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const withoutFence = fencedMatch ? fencedMatch[1].trim() : direct;

  // Prefer object blocks, then array blocks.
  const objectMatch = withoutFence.match(/\{[\s\S]*\}/);
  const arrayMatch = withoutFence.match(/\[[\s\S]*\]/);
  const jsonString = objectMatch
    ? objectMatch[0]
    : arrayMatch
      ? arrayMatch[0]
      : withoutFence;

  try {
    return JSON.parse(jsonString);
  } catch {
    return fallback;
  }
}
