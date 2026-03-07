"use client";

import type { ClientToServerEvents, ServerToClientEvents } from "@word-hunt/shared";
import { io, type Socket } from "socket.io-client";

let socketSingleton: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

function realtimeUrl(): string {
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (configured) {
    return configured;
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname, origin } = window.location;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${protocol}//${hostname}:4001`;
    }
    return origin;
  }

  return "http://localhost:4001";
}

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (!socketSingleton) {
    socketSingleton = io(realtimeUrl(), {
      autoConnect: false,
      transports: ["websocket"]
    });
  }

  return socketSingleton;
}
