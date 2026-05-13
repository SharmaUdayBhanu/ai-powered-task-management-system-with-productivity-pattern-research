import { io } from "socket.io-client";
import { REALTIME_SOCKET_OPTIONS, REALTIME_SOCKET_URL, ENABLE_REALTIME } from "./realtime";

let cached = null;

export default function getSocket() {
  if (!ENABLE_REALTIME) return null;
  if (cached) return cached;
  try {
    cached = io(REALTIME_SOCKET_URL, REALTIME_SOCKET_OPTIONS);
  } catch (err) {
    // Fallback: return null if socket cannot be created
    cached = null;
  }
  return cached;
}
