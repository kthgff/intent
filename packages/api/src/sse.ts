import type { StreamEvent } from '@veto/conductor';
/**
 * SSE hub for `GET /api/v1/stream` (API.md "Live channel").
 *
 * One event source per client; `notify` fans a {@link StreamEvent}
 * out to every connected reply. Every streamed fact is also written
 * durably before notify is called (DB rows, log files)
 * — the stream is a latency optimization, never the only copy, so a
 * reconnecting client re-reads state and no replay protocol is needed.
 */
import type { FastifyReply } from 'fastify';

export type { StreamEvent };

interface Client {
  reply: FastifyReply;
}

export class StreamHub {
  readonly #clients = new Set<Client>();

  /** Slow-consumer cap (bytes). A client that never drains would
   *  buffer frames in memory forever — past this we drop it; the
   *  stream is a latency optimization, never the only copy. */
  static readonly MAX_BUFFERED = 1024 * 1024;

  get size(): number {
    return this.#clients.size;
  }

  /** Register an SSE client; caller has already flushed headers. */
  add(reply: FastifyReply): void {
    const client: Client = { reply };
    this.#clients.add(client);
    const drop = () => this.#clients.delete(client);
    reply.raw.on('close', drop);
    reply.raw.on('error', drop);
  }

  /** Broadcast one event to every connected client. */
  notify(event: StreamEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(
      event.payload,
    )}\n\n`;
    for (const client of this.#clients) {
      try {
        const flushed = client.reply.raw.write(frame);
        if (
          !flushed &&
          client.reply.raw.writableLength > StreamHub.MAX_BUFFERED
        ) {
          // Backpressure: over the cap → cut the client loose so its
          // buffer can't grow unbounded.
          this.#clients.delete(client);
          client.reply.raw.destroy();
        }
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  /** End every client stream (server shutdown, tests). */
  closeAll(): void {
    for (const client of this.#clients) {
      try {
        client.reply.raw.end();
      } catch {
        /* already closed */
      }
    }
    this.#clients.clear();
  }
}
