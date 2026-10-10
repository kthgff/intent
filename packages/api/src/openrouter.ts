import type { EffectiveConfig } from '@veto/config';
/**
 * api/openrouter.ts — the Board Assistant's completion provider
 * (BOARD-CHAT-TDD contract amendment 4, wp-164).
 *
 * Thin OpenAI-compatible chat-completions client over `fetch` — the
 * same envelope a self-hosted vLLM endpoint speaks, so the "Vast.ai
 * later" path is a base-URL change, not a port. The key comes from
 * `config.secrets.OPENROUTER_API_KEY` (.env only — never logged,
 * never in config.yaml).
 *
 * Resolution is fail-closed: unresolved model, missing key, or a
 * provider-allowlist miss → `undefined` provider (every consumer
 * degrades deterministically per PRD R10) or a loud RouteError at
 * wiring time — never a silent half-configured client. No streaming
 * (PRD non-goal); caller-side zod re-validation stays authoritative
 * even when `response_format` constrains the decode.
 */
import type { CompletionProvider, ConverseMessage } from '@veto/core';
import type { RouteDecision } from '@veto/core';
import { assertRouteProvider, resolveModelRoute } from '@veto/prompts';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Interactive latency budget — one non-streamed completion. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface AssistantProviderResolution {
  /** The provider, or undefined when unconfigured (deterministic mode). */
  provider: CompletionProvider | undefined;
  /** The registry-resolved model id (echoed as `model` on panel state). */
  model: string | null;
  /** The route the provider was wired for — for tests/inspection. */
  route: RouteDecision;
}

/**
 * Resolve kind `assistant` through the routing registry and build the
 * OpenRouter provider. Returns `provider: undefined` when the model or
 * key is absent; throws `RouteError` when the route's providers
 * allowlist excludes `openrouter` (a pinned route can't silently fall
 * to an unlisted provider).
 */
export function resolveAssistantProvider(opts: {
  config: EffectiveConfig;
  /** Injectable fetch for tests — never calls live OpenRouter. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
}): AssistantProviderResolution {
  const route = resolveModelRoute(opts.config, 'assistant');
  const apiKey = opts.config.secrets.OPENROUTER_API_KEY;
  if (!route.model || !apiKey) {
    return { provider: undefined, model: route.model ?? null, route };
  }
  assertRouteProvider(route, 'openrouter');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = route.model;

  const provider: CompletionProvider = {
    async converse(messages: ConverseMessage[], cOpts): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        messages,
        ...(route.max_output_tokens != null
          ? { max_tokens: route.max_output_tokens }
          : cOpts?.maxOutputTokens != null
            ? { max_tokens: cOpts.maxOutputTokens }
            : {}),
        ...(route.schema_required && cOpts?.jsonSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: cOpts.jsonSchema.name,
                  strict: true,
                  schema: cOpts.jsonSchema.schema,
                },
              },
            }
          : {}),
      };
      const res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(
          `openrouter chat/completions failed: ${res.status} ${res.statusText}`,
        );
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(
          'openrouter response had no choices[0].message.content',
        );
      }
      return content;
    },
  };
  return { provider, model, route };
}
