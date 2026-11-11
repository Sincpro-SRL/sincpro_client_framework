import {
  CircuitOpen,
  type CircuitState,
  countedByDefault,
} from "@sincpro/client-framework/circuit_breaker/domain/circuit";

export type CircuitBreakerOptions = {
  /** Consecutive counted failures that open it (5). */
  readonly failures?: number;
  /** How long it stays open before it lets one call try, in ms (30 s). */
  readonly openFor?: number;
  /** What counts as the dependency not answering (`countedByDefault`). */
  readonly counts?: (error: unknown) => boolean;
  /** Milliseconds since the epoch — what a test moves by hand (`Date.now`). */
  readonly clock?: () => number;
};

/**
 * Stops calling a dependency that fails repeatedly, and tries it again once it may be back — the
 * backend's `CircuitBreaker`, in this process's memory.
 *
 *     const odoo = new CircuitBreaker("odoo", { failures: 3, openFor: 60_000 });
 *     await odoo.call(() => client.callModel("sale.order", "create", values));
 *     const send = odoo.wrap(sendInvoice);                 // the same, as a function
 *     const transport = guardedTransport(restTransport({ base }), odoo);
 *
 * Context: a phone without coverage or a backend that is down answers every call slowly with the
 * same failure; trying it again at once only spends battery and blocks what waits. After
 * `failures` counted failures in a row it opens: calls fail at once with `CircuitOpen` —
 * `unavailable`, with the time left as its `retryAfter` —, which `failureOf`, a stored queue and a
 * screen already handle. Once `openFor` passed, one call tries (half-open): an answer closes it,
 * a counted failure opens it again. A refusal (`domain`, `not_found`…) is an answer and never
 * counts. Each process keeps its own circuit: a tab, the app.
 */
export class CircuitBreaker {
  private readonly failures: number;
  private readonly openFor: number;
  private readonly counts: (error: unknown) => boolean;
  private readonly clock: () => number;
  private streak = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(
    readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failures = options.failures ?? 5;
    this.openFor = options.openFor ?? 30_000;
    this.counts = options.counts ?? countedByDefault;
    this.clock = options.clock ?? Date.now;
    if (!Number.isInteger(this.failures) || this.failures < 1) {
      throw new TypeError(`circuit ${name}: failures must be 1 or more`);
    }
    if (!(this.openFor > 0))
      throw new TypeError(`circuit ${name}: openFor must be some time`);
  }

  /** Where it stands now. */
  state(): CircuitState {
    if (this.openedAt === undefined) return "closed";
    return this.clock() < this.openedAt + this.openFor ? "open" : "half_open";
  }

  /** Closed again, as if it never failed — what an operator or a test does. */
  reset(): void {
    this.streak = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /**
   * `work` run through the circuit.
   *
   * 1. Open: refused at once (`CircuitOpen`, the time left as its wait); half-open with a call
   *    already trying: refused, a second's wait.
   * 2. Run. An answer — or a failure that does not count — closes it.
   * 3. A counted failure: half-open, it opens again; closed, one more in the streak, and at
   *    `failures` it opens.
   * Final: what `work` answered, or what it failed with.
   */
  async call<T>(work: () => T | Promise<T>): Promise<T> {
    const state = this.state();
    if (state === "open") {
      throw new CircuitOpen(
        this.name,
        ((this.openedAt ?? 0) + this.openFor - this.clock()) / 1000,
      );
    }
    const probe = state === "half_open";
    if (probe && this.probing) throw new CircuitOpen(this.name, 1);
    if (probe) this.probing = true;
    try {
      const answer = await work();
      this.reset();
      return answer;
    } catch (error) {
      if (!this.counts(error)) {
        if (probe) this.reset();
        throw error;
      }
      this.probing = false;
      this.streak += 1;
      if (probe || this.streak >= this.failures) this.openedAt = this.clock();
      throw error;
    }
  }

  /** `fn`, every call of it through the circuit. */
  wrap<A extends unknown[], T>(
    fn: (...args: A) => T | Promise<T>,
  ): (...args: A) => Promise<T> {
    return (...args: A) => this.call(() => fn(...args));
  }
}
