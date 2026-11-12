import { failureOf } from "@sincpro/client-framework/common/failures";
import type { FailureDescription } from "@sincpro/client-framework/observability/domain/logging";
import type { Outcome } from "@sincpro/client-framework/observability/domain/tracing";

/** A message is cut here: a line is a description, not a dump. */
const MAX_MESSAGE = 500;

/**
 * Frames of the framework itself — the installed package, or its own sources —: where a failure
 * was raised is the first frame outside them.
 */
const FRAMEWORK_FRAME =
  /@sincpro\/client-framework\/|sincpro_client_framework\/src\/|node:internal/;

/**
 * What a failure says on its log line, its span and its report — sincpro_framework's failure
 * (`observability/failure.py`): its type, its kind, whether it is a fault, its message, where it
 * was raised and, when nobody expected it, its stack.
 *
 *     describeFailure(new TypeError("x is undefined"), "failed")
 *       → { type: "TypeError", kind: "internal", fault: true, message: "x is undefined",
 *           at: "SaveServer.execute (save_server.feature.ts:20:5)", stack: "TypeError: …" }
 *     describeFailure(new TransportError("/x", 409, null), "refused")
 *       → { type: "TransportError", kind: "conflict", fault: false }   // expected: no message, no stack
 *     describeFailure(error, "failed", "odoo.SaveServer")
 *       → { type, kind, fault, message, failedIn: "odoo.SaveServer" }  // told once, where it failed
 *
 * Context: a failure is described once — by the run where it was raised —; a run it crosses on
 * the way out says only its type and where it failed (`failedIn`). An expected one (`refused`,
 * `aborted`) is the business answering or the caller leaving: its type and kind, never its
 * message, which may carry the caller's data. Never the DTO, the result or the context.
 */
export function describeFailure(
  error: unknown,
  outcome: Outcome,
  failedIn?: string,
): FailureDescription {
  const failure = failureOf(error);
  const type = typeOf(error);
  const base = {
    type,
    kind: failure.aborted ? "aborted" : failure.kind,
    fault: failure.fault,
  };
  if (outcome !== "failed") return base;
  const message = messageOf(error);
  if (failedIn) return { ...base, ...(message ? { message } : {}), failedIn };
  const stack = error instanceof Error ? error.stack : undefined;
  const at = stack ? raisedAt(stack) : undefined;
  return {
    ...base,
    ...(message ? { message } : {}),
    ...(at ? { at } : {}),
    ...(stack ? { stack } : {}),
  };
}

/** The class's name, as every signal spells it (`error.type`). */
function typeOf(error: unknown): string {
  if (error instanceof Error) {
    const named = error.constructor?.name;
    return named && named !== "Object" ? named : error.name || "Error";
  }
  return error === null ? "null" : typeof error;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/**
 * Where it was raised: the first frame of the stack outside the framework — the use case's own
 * code (`SaveServer.execute (save_server.feature.ts:20:5)`), V8's `at …` or JavaScriptCore's
 * `name@file:line`.
 */
function raisedAt(stack: string): string | undefined {
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim().replace(/^at /, "");
    if (frame && !FRAMEWORK_FRAME.test(frame)) return frame;
  }
  return undefined;
}
