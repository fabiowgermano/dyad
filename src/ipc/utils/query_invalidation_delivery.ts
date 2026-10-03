import type { WindowEndpoint } from "@/window_infrastructure/main/window_registry";
import { queryInvalidationBus } from "@/window_infrastructure/main/query_invalidation_bus";
import type { QueryInvalidationScope } from "@/window_infrastructure/types";

export function publishQueryInvalidations(
  scopes: readonly QueryInvalidationScope[],
  origin?: WindowEndpoint,
): void {
  queryInvalidationBus.publish(
    scopes,
    origin === undefined ? {} : { originEndpoint: origin },
  );
}
