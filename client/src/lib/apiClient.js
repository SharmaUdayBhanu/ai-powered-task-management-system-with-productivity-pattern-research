import axios from "axios";

const BASE_URL = import.meta.env.VITE_API_URL || "";
const API_URL = `${BASE_URL}/api`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRetryDelay = (error, attempt) => {
  const headerRetry = error?.response?.headers?.["retry-after"];
  if (headerRetry) {
    const numeric = Number(headerRetry);
    if (!Number.isNaN(numeric)) {
      return Math.max(800, numeric * 1000);
    }
  }

  const retryAfterMs = error?.response?.data?.retryAfterMs;
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.max(800, retryAfterMs);
  }

  return 600 * attempt;
};

export const sanitizeApiError = (error, fallback = "Something went wrong.") => {
  const status = error?.response?.status;

  if (status === 429) {
    return "AI service is busy right now. Please retry in a moment.";
  }

  if (status >= 500) {
    return "Server is temporarily unavailable. Please try again shortly.";
  }

  return fallback;
};

export const requestWithRetry = async (
  requestFactory,
  {
    maxRetries = 2,
    retryOnStatuses = [429, 500, 502, 503, 504],
    fallbackValue,
  } = {},
) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return await requestFactory();
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      const shouldRetry =
        retryOnStatuses.includes(status) && attempt <= maxRetries;

      if (!shouldRetry) {
        if (fallbackValue !== undefined) return fallbackValue;
        throw error;
      }

      await sleep(getRetryDelay(error, attempt));
    }
  }

  if (fallbackValue !== undefined) return fallbackValue;
  throw lastError;
};

export const getWithRetry = async (path, options = {}) => {
  return requestWithRetry(() => axios.get(`${API_URL}${path}`), options);
};

export const postWithRetry = async (path, payload, options = {}) => {
  return requestWithRetry(
    () => axios.post(`${API_URL}${path}`, payload),
    options,
  );
};

export const putWithRetry = async (path, payload, options = {}) => {
  return requestWithRetry(
    () => axios.put(`${API_URL}${path}`, payload),
    options,
  );
};

export default API_URL;
