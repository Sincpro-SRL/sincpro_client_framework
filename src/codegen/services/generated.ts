import type { Metamodel } from "@sincpro/client-framework/codegen/domain/metamodel";
import {
  GENERATED_ADAPTERS,
  GENERATED_DOMAIN,
} from "@sincpro/client-framework/codegen/domain/names";
import { clientFileOf } from "@sincpro/client-framework/codegen/services/client";
import { domainFilesOf } from "@sincpro/client-framework/codegen/services/domain";
import { entitiesFileOf } from "@sincpro/client-framework/codegen/services/entities";
import type { GenerateOptions } from "@sincpro/client-framework/codegen/services/rest";

/**
 * Every file `sincpro-client generate` writes for a bounded context, by its path from the
 * context's folder — each in the layer it belongs to, beside the application's own code of that
 * layer:
 *
 *     domain/generated/models.ts       entities and value objects
 *     domain/generated/commands.ts     Commands and Responses
 *     domain/generated/events.ts       domain events (a contract exported with them)
 *     domain/generated/index.ts        the three, re-exported
 *     adapters/generated/client.ts     every operation, over any wire
 *     adapters/generated/entities.ts   what screens list, read and edit
 *
 * Context: the backend keeps these apart — the domain's words, the application layer's DTOs, the
 * facts, the adapters to another system —, and so does an application laid out like it. Written
 * side by side, the application had to move them itself. A bare metamodel (`export_metamodel`,
 * no bindings) is only a domain: no adapter is written.
 *
 *     generatedFilesOf(project, { domain: "project", base: "/v1" })
 *       -> { "domain/generated/models.ts": "…", …, "adapters/generated/entities.ts": "…" }
 */
export function generatedFilesOf(
  metamodel: Metamodel,
  options: GenerateOptions = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, source] of Object.entries(domainFilesOf(metamodel)))
    files[`${GENERATED_DOMAIN}/${name}`] = source;
  if (metamodel.bindings !== undefined) {
    files[`${GENERATED_ADAPTERS}/client.ts`] = clientFileOf(metamodel, options);
    files[`${GENERATED_ADAPTERS}/entities.ts`] = entitiesFileOf(metamodel, options);
  }
  return files;
}
