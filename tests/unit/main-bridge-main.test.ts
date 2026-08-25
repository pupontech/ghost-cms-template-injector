import { describe, expect, it } from 'vitest';

import { BRIDGE_SOURCE_ID, createBridgeRequest } from '../../src/bridge-protocol';
import { isPageBridgeInbound } from '../../src/main-bridge-main';

describe('MAIN bridge entry inbound filter (C3 response-echo guard)', () => {
  it('accepts a valid bridge request', () => {
    const req = createBridgeRequest('discover', {});
    expect(isPageBridgeInbound(req)).toBe(true);
  });

  it('ignores a response-shaped message (its own reply) so it cannot re-enter handle', () => {
    const res = {
      v: 1,
      source: BRIDGE_SOURCE_ID,
      nonce: '00000000-0000-4000-8000-000000000000',
      ok: true,
      result: { capabilities: [] },
    };
    expect(isPageBridgeInbound(res)).toBe(false);
  });

  it('ignores messages that only match source+version but are not requests', () => {
    // Pre-fix filter keyed on loose source/v checks; a response-sibling object
    // with matching source/v (but no valid op/nonce/payload) must be dropped.
    const loose = { v: 1, source: 'ghost-cms-template-injector/page-bridge/v1' };
    expect(isPageBridgeInbound(loose)).toBe(false);
  });

  it('ignores a request with a foreign source', () => {
    const req = {
      v: 1,
      op: 'discover',
      nonce: '00000000-0000-4000-8000-000000000000',
      source: 'imposter',
      payload: {},
    };
    expect(isPageBridgeInbound(req)).toBe(false);
  });
});
