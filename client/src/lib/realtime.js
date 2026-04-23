export const ENABLE_REALTIME = import.meta.env.VITE_ENABLE_REALTIME === "true";

export const REALTIME_SOCKET_URL =
  import.meta.env.VITE_API_URL || window.location.origin;

export const REALTIME_SOCKET_OPTIONS = {
  transports: ["websocket", "polling"],
  reconnectionAttempts: 2,
  timeout: 5000,
};
