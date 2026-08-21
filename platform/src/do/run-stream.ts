import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/**
 * Live run streaming.
 *
 * One instance per run, addressed by run id. The runner posts step transitions
 * to it; connected browsers get them over a WebSocket. This is the platform's
 * version of the CLI's `--view-dag` live view, except that many people can watch
 * the same run and the state survives a reconnect.
 *
 * WebSocket hibernation matters here: a run that sleeps for six hours between
 * steps should not hold a Durable Object in memory, and with hibernation the
 * sockets stay open while the object is evicted.
 */
export class RunStream extends DurableObject<Env> {
  /** Frames replayed to a client that connects mid-run. */
  private static readonly BACKLOG_LIMIT = 500;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/publish") {
      const frame = await request.text();
      await this.append(frame);
      this.broadcast(frame);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      // Hibernatable: the runtime can evict this object and keep the socket.
      this.ctx.acceptWebSocket(server);

      // Replay what already happened, so a late viewer sees the whole run
      // rather than only what follows their connection.
      const backlog = await this.backlog();
      for (const frame of backlog) server.send(frame);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/backlog") {
      return Response.json(await this.backlog());
    }

    return new Response("not found", { status: 404 });
  }

  webSocketMessage(): void {
    // Clients only listen. Control actions go through the API, which is where
    // authorisation lives.
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  private broadcast(frame: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
      } catch {
        // A dead socket is dropped by the runtime; nothing to do here.
      }
    }
  }

  private async append(frame: string): Promise<void> {
    const frames = await this.backlog();
    frames.push(frame);
    // Bound the backlog: a long run's tail is what a viewer needs, and the
    // authoritative history is in D1 either way.
    const trimmed = frames.slice(-RunStream.BACKLOG_LIMIT);
    await this.ctx.storage.put("frames", trimmed);
  }

  private async backlog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("frames")) ?? [];
  }
}
