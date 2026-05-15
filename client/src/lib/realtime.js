export const ENABLE_REALTIME = import.meta.env.VITE_ENABLE_REALTIME !== "false";

export const REALTIME_SOCKET_URL =
  import.meta.env.VITE_API_URL || window.location.origin;

export const REALTIME_SOCKET_OPTIONS = {
  transports: ["websocket", "polling"],
  reconnectionAttempts: 25,
  reconnectionDelay: 250,
  reconnectionDelayMax: 4000,
  timeout: 7000,
};
