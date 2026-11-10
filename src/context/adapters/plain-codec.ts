import {
  type ContextCodec,
  travelling,
} from "@sincpro/client-framework/context/domain/codec";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";

/** The codec for anything outside the codebase: only the values that travel, as JSON. */
export const plainCodec: ContextCodec = {
  dumps: (values) => JSON.stringify(travelling(values)),
  loads(text) {
    try {
      const found: unknown = JSON.parse(text);
      return found !== null && typeof found === "object" && !Array.isArray(found)
        ? (found as ContextValues)
        : {};
    } catch {
      return {};
    }
  },
};
