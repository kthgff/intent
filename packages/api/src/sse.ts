import type { StreamEvent } from '@sprint-runner/conductor';
/**
 * SSE hub for `GET /api/v1/stream` (API.md "Live channel").
 *
 * One event source per client; `notify` fans a {@link StreamEvent}
 * out to every connected reply. Every streamed fact is also written
 * durably before notify is called (events.jsonl, DB rows, log files)
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

  get size(): number {
    return this.#clients.size;
  }

  /** Register an SSE client; caller has already flushed headers. */
  add(reply: FastifyReply): void {
    const client: Client = { reply };
    this.#clients.add(client);
    reply.raw.on('close', () => this.#clients.delete(client));
  }

  /** Broadcast one event to every connected client. */
  notify(event: StreamEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(
      event.payload,
    )}\n\n`;
    for (const client of this.#clients) {
      try {
        client.reply.raw.write(frame);
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
