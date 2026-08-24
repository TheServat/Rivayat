/**
 * Every call this screen makes, against the routes the API actually serves.
 *
 * Verified live on 2026-08-23 against `apps/api` on `:3000`, not read off a design
 * document - the run and event routes were being finished by another agent while this
 * screen was built, so each one below was exercised with `curl` and the response shape
 * is what this file validates against.
 *
 * It composes `StudioTransport` rather than extending `StudioApi` for the same reason
 * `render-wire.ts` keeps its schemas local: `src/api/client.ts` is the file every other
 * screen is adding methods to right now. The transport is the seam, validation still
 * happens inside it, and nothing here reaches the network on its own.
 */

import type { ProjectId, RunId } from '@rv/contracts';

import type { StudioTransport } from '../../api/transport';

import { CostReport, FormatProfileList, RunSummary, RunSummaryList } from './render-wire';

export class RenderApi {
  readonly #transport: StudioTransport;

  constructor(transport: StudioTransport) {
    this.#transport = transport;
  }

  /** The verified platform specs. Data, not a render: this one never costs anything. */
  formats(signal?: AbortSignal): Promise<FormatProfileList> {
    return this.#transport.send({
      method: 'GET',
      path: '/render/formats',
      schema: FormatProfileList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  runs(projectId: ProjectId, signal?: AbortSignal): Promise<RunSummaryList> {
    return this.#transport.send({
      method: 'GET',
      path: `/projects/${projectId}/runs`,
      schema: RunSummaryList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  run(runId: RunId, signal?: AbortSignal): Promise<RunSummary> {
    return this.#transport.send({
      method: 'GET',
      path: `/runs/${runId}`,
      schema: RunSummary,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  cost(projectId: ProjectId, signal?: AbortSignal): Promise<CostReport> {
    return this.#transport.send({
      method: 'GET',
      path: `/projects/${projectId}/cost`,
      schema: CostReport,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * 202 with the run in `cancelled`, or a 409 when it is already terminal.
   *
   * The conflict is not an error worth a red banner: it means someone else - or the
   * run itself - got there first, and the right response is to show the state the
   * server reports rather than to complain.
   */
  cancel(runId: RunId): Promise<RunSummary> {
    return this.#transport.send({
      method: 'POST',
      path: `/runs/${runId}/cancel`,
      schema: RunSummary,
    });
  }

  /**
   * Continues from the first stage without a matching checkpoint.
   *
   * This is the whole reason a render that takes minutes is survivable: the frames a
   * killed run wrote are addressed by the *content* being rendered, not by the run, so
   * a new process finds them and picks up where the old one stopped.
   */
  resume(runId: RunId): Promise<RunSummary> {
    return this.#transport.send({
      method: 'POST',
      path: `/runs/${runId}/resume`,
      schema: RunSummary,
    });
  }
}
