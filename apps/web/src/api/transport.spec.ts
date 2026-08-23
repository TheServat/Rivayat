import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { errorMessageKey } from './error-messages';
import { ApiError } from './errors';
import { HttpTransport } from './transport';

const Payload = z.strictObject({ id: z.string(), count: z.number().int() });

function respondWith(body: unknown, status = 200): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
}

describe('HttpTransport response validation', () => {
  it('returns the parsed value when the response satisfies its schema', async () => {
    const transport = new HttpTransport('/api', respondWith({ id: 'a', count: 2 }));
    await expect(
      transport.send({ method: 'GET', path: '/thing', schema: Payload }),
    ).resolves.toEqual({ id: 'a', count: 2 });
  });

  /**
   * The load-bearing test for the boundary.
   *
   * A 200 with the wrong shape is the dangerous case: nothing about the HTTP exchange
   * says anything is wrong, so without validation the payload lands in a store and the
   * failure surfaces three components later as a rendering bug. It has to reject.
   */
  it('rejects a well-formed response that fails its schema', async () => {
    const transport = new HttpTransport('/api', respondWith({ id: 'a', count: 'two' }));

    const failure = await transport.send({ method: 'GET', path: '/thing', schema: Payload }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toBe('schema');
    expect((failure as ApiError).code).toBe('response-schema-mismatch');
    expect((failure as ApiError).issues).toEqual([
      { path: 'count', message: expect.stringContaining('number'), code: expect.any(String) },
    ]);
  });

  it('rejects an unexpected extra field rather than passing it through', async () => {
    // `strictObject` is the contract. A server that starts sending a field the client
    // does not know about is a version skew, and silently ignoring it is how a client
    // ends up two schema versions behind without anyone noticing.
    const transport = new HttpTransport('/api', respondWith({ id: 'a', count: 1, extra: true }));
    await expect(
      transport.send({ method: 'GET', path: '/thing', schema: Payload }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('HttpTransport request shaping', () => {
  it('joins the base URL and the path without doubling the slash', async () => {
    let seen = '';
    const asString = (input: RequestInfo | URL): string => {
      if (typeof input === 'string') return input;
      return input instanceof URL ? input.href : input.url;
    };
    const transport = new HttpTransport('http://api.test/v1/', (url) => {
      seen = asString(url);
      return Promise.resolve(new Response('{"id":"a","count":1}', { status: 200 }));
    });
    await transport.send({ method: 'GET', path: '/thing', schema: Payload });
    expect(seen).toBe('http://api.test/v1/thing');
  });

  it('announces a JSON body only when there is one', async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const transport = new HttpTransport('/api', (_url, init) => {
      seen.push(init?.headers);
      return Promise.resolve(new Response('{"id":"a","count":1}', { status: 200 }));
    });

    await transport.send({ method: 'GET', path: '/thing', schema: Payload });
    await transport.send({ method: 'POST', path: '/thing', schema: Payload, body: { a: 1 } });

    expect(seen[0]).toEqual({ Accept: 'application/json' });
    expect(seen[1]).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('sends a PUT, which is how one settings layer is written', async () => {
    let seen = '';
    const transport = new HttpTransport('/api', (_url, init) => {
      seen = init?.method ?? '';
      return Promise.resolve(new Response('{"id":"a","count":1}', { status: 200 }));
    });
    await transport.send({
      method: 'PUT',
      path: '/settings/global',
      schema: Payload,
      body: { scope: { projectId: null, runId: null }, set: [], clear: [] },
    });
    expect(seen).toBe('PUT');
  });

  it('forwards an abort signal so a screen can cancel its own request', async () => {
    let seen: AbortSignal | undefined;
    const transport = new HttpTransport('/api', (_url, init) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response('{"id":"a","count":1}', { status: 200 }));
    });
    const controller = new AbortController();
    await transport.send({
      method: 'GET',
      path: '/thing',
      schema: Payload,
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });

  it('treats an empty 204 body as undefined rather than a parse failure', async () => {
    const transport = new HttpTransport('/api', () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    await expect(
      transport.send({ method: 'DELETE', path: '/thing', schema: z.undefined() }),
    ).resolves.toBeUndefined();
  });
});

describe('HttpTransport error mapping', () => {
  /**
   * The envelope is nested under `error`, and reading it flat was a real bug.
   *
   * A flat schema never matched, so every failure fell through to the status-derived
   * fallback: `budget.exceeded` arrived as `http-402` with its kind, context and issues
   * discarded, and the studio rendered a generic message for an error the server had
   * described precisely. This asserts the nesting, not just the mapping.
   */
  it('maps the server envelope to a localisable failure', async () => {
    const transport = new HttpTransport(
      '/api',
      respondWith(
        {
          error: {
            code: 'budget.exceeded',
            kind: 'budget',
            message: 'run would exceed the ceiling',
            retryable: false,
            context: { ceilingNanoUsd: 5_000_000_000 },
            status: 402,
          },
        },
        402,
      ),
    );

    const failure = (await transport
      .send({ method: 'GET', path: '/runs', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.failure).toBe('api');
    expect(failure.kind).toBe('budget');
    expect(failure.code).toBe('budget.exceeded');
    expect(failure.status).toBe(402);
    expect(failure.context.ceilingNanoUsd).toBe(5_000_000_000);
    expect(errorMessageKey(failure)).toBe('errors.kind.budget');
  });

  it('carries the rejected fields through, so a form can mark them', async () => {
    // A settings patch is the case this exists for: "three invalid entries" with no
    // paths makes the user hunt for the three the server already identified.
    const transport = new HttpTransport(
      '/api',
      respondWith(
        {
          error: {
            code: 'settings.patch-rejected',
            kind: 'validation',
            message: 'Settings patch rejected: 2 invalid entries.',
            retryable: false,
            context: {},
            issues: [
              { path: 'render.concurrency', message: 'too big', code: 'too_big' },
              { path: 'image.lane', message: 'invalid option', code: 'invalid_value' },
            ],
            status: 400,
          },
        },
        400,
      ),
    );

    const failure = (await transport
      .send({ method: 'PUT', path: '/settings/global', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.code).toBe('settings.patch-rejected');
    expect(failure.issues.map((issue) => issue.path)).toEqual(['render.concurrency', 'image.lane']);
  });

  it('still falls back to a status-derived error for a body that is not the envelope', async () => {
    const transport = new HttpTransport('/api', respondWith({ nope: true }, 503));
    const failure = (await transport
      .send({ method: 'GET', path: '/runs', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.code).toBe('http-503');
    expect(failure.kind).toBe('internal');
    expect(failure.retryable).toBe(true);
  });

  it('does not accept the old flat body, which was never what the API sent', async () => {
    // Guards the fix: a flat `{code, kind, ...}` must *not* parse, or the nesting could
    // be reverted without a test noticing.
    const transport = new HttpTransport(
      '/api',
      respondWith({ code: 'budget.exceeded', kind: 'budget', message: '', retryable: false }, 402),
    );
    const failure = (await transport
      .send({ method: 'GET', path: '/runs', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.code).toBe('http-402');
  });

  it('does not mistake an HTML error page for a JSON body', async () => {
    const transport = new HttpTransport('/api', () =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    const failure = (await transport
      .send({ method: 'GET', path: '/runs', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.code).toBe('http-502');
  });

  it('reports an unreachable server as a network failure, not a schema one', async () => {
    const transport = new HttpTransport('/api', () => Promise.reject(new Error('ECONNREFUSED')));
    const failure = (await transport
      .send({ method: 'GET', path: '/runs', schema: Payload })
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.failure).toBe('network');
    expect(errorMessageKey(failure)).toBe('errors.network');
    expect(failure.retryable).toBe(true);
  });
});
