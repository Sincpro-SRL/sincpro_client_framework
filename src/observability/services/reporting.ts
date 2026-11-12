import { newEntityId } from "@sincpro/client-framework/common/ids";
import { processContext } from "@sincpro/client-framework/context/infrastructure/process";
import { tenantOf } from "@sincpro/client-framework/observability/domain/identity";
import { observabilityNow } from "@sincpro/client-framework/observability/infrastructure/registry";

/**
 * Whether this is the first time this error is reported. A Feature that fails inside an
 * ApplicationService throws through it, and a screen that draws the failure may break on it:
 * the error is reported once, by the first that saw it — its span is the one that says where.
 */
const REPORTED = new WeakSet<object>();

export function firstReport(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function"))
    return true;
  if (REPORTED.has(error)) return false;
  REPORTED.add(error);
  return true;
}

/**
 * Reports what nobody expected that is not a use case — a screen that broke while drawing, a
 * subscriber, a worker — through the process's reporter, with the process's context.
 *
 *     <Composer onViewError={(error, { resource }) => reportError(error, `view ${formatRef(resource)}`)} />
 *     ErrorUtils.setGlobalHandler((error) => reportError(error, "react-native global"));
 *
 * Context: a use case reports its own failures (the bounded context does it for it); what fails
 * outside one would only reach a console. `where` takes the place of the use case's name in the
 * report. Only what failed is reported (`outcomeOf`: a refusal the server explained or an abort is
 * not); an error a use case already reported is not reported again; and a reporter that throws is
 * ignored: telling about a failure never becomes a second one.
 */
export function reportError(error: unknown, where: string): void {
  const settings = observabilityNow();
  try {
    // What the server explained, or what the caller stopped waiting for, is not a fault here either.
    if (settings.outcomeOf(error) !== "failed") return;
  } catch {
    // An outcome that cannot be told is a failure.
  }
  if (!firstReport(error)) return;
  try {
    const context = processContext.values;
    const tenant = tenantOf(context, settings.identity);
    settings.reporter?.report(error, {
      useCase: where,
      traceId: "",
      executionId: newEntityId(),
      context,
      ...(settings.identity ? { release: settings.identity.release } : {}),
      ...(tenant ? { tenant } : {}),
    });
  } catch {
    // Ignored, as a reporter that fails inside a use case is.
  }
}
