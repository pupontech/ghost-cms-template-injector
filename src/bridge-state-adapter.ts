/**
 * Phase-5 integration glue: isolated-world adapter that drives the C3 MAIN-world
 * bridge on behalf of the apply pipeline.
 *
 * The `ghost-state` adapter (which owns the serialized native transaction) runs
 * INSIDE the MAIN world (see `src/main-bridge.ts`). The isolated content script
 * must not reach Ghost internals directly, so this thin proxy forwards
 * discover/snapshot/apply over the validated `page-bridge` protocol
 * (`createPageBridge`). Every reply is validated for source + nonce by the
 * bridge client; failures surface as thrown errors so `runApplyPipeline`
 * reports them as `{ status: 'error' }`.
 */

import type { PageBridge } from './page-bridge';
import type { ApplicationPlan } from './preset-engine';
import type { ApplyResult, DiscoverOutcome, GhostSnapshot } from './ghost-state';
import type { ApplyPipelineAdapter } from './apply-pipeline';

export function createBridgeStateAdapter(bridge: PageBridge): ApplyPipelineAdapter {
  return {
    discover(): Promise<DiscoverOutcome> {
      return bridge
        .request('discover', {})
        .then((r) =>
          r.ok ? (r.result as DiscoverOutcome) : { supported: false, reason: r.error },
        );
    },

    snapshot(): Promise<GhostSnapshot> {
      return bridge.request('snapshot', {}).then((r) => {
        if (r.ok) return r.result as GhostSnapshot;
        throw new Error(r.error);
      });
    },

    apply(plan: ApplicationPlan): Promise<ApplyResult> {
      return bridge.request('apply', { plan }).then((r) => {
        if (r.ok) return r.result as ApplyResult;
        throw new Error(r.error);
      });
    },
  };
}
