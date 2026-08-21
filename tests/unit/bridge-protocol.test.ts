import { describe, expect, it } from 'vitest';

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE_ID,
  createBridgeRequest,
  isBridgeRequest,
  isBridgeResponse,
  validateBridgeResponse,
} from '../../src/bridge-protocol';

describe('bridge protocol (C3)', () => {
  it('pins a fixed protocol version and source identity', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(typeof BRIDGE_SOURCE_ID).toBe('string');
    expect(BRIDGE_SOURCE_ID.length).toBeGreaterThan(0);
  });

  it('creates schema-valid requests for every allowlisted operation', () => {
    for (const op of ['discover', 'snapshot', 'planApply', 'apply', 'save', 'rollback'] as const) {
      const req = createBridgeRequest(op, {});
      expect(req.v).toBe(BRIDGE_PROTOCOL_VERSION);
      expect(req.op).toBe(op);
      expect(req.source).toBe(BRIDGE_SOURCE_ID);
      expect(req.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(req.payload).toEqual({});
    }
  });

  it('rejects operations outside the fixed allowlist', () => {
    const forged = {
      v: BRIDGE_PROTOCOL_VERSION,
      op: 'eval',
      nonce: crypto.randomUUID(),
      source: BRIDGE_SOURCE_ID,
      payload: { code: 'alert(1)' },
    };
    expect(isBridgeRequest(forged)).toBe(false);
  });

  it('rejects malformed requests: wrong version, missing fields, non-cloneable payloads', () => {
    const base = () => createBridgeRequest('snapshot', { tabId: 1 });
    expect(isBridgeRequest({ ...base(), v: 99 })).toBe(false);
    expect(isBridgeRequest({ ...base(), nonce: 'not-a-uuid' })).toBe(false);
    expect(isBridgeRequest({ ...base(), source: 'imposter' })).toBe(false);
    expect(isBridgeRequest({ ...base(), op: undefined })).toBe(false);
    // Function in payload is not structured-cloneable.
    expect(isBridgeRequest(createBridgeRequest('snapshot', { fn: () => 1 }))).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeRequest('discover')).toBe(false);
  });

  it('accepts valid responses only from the bridge identity with matching request id', () => {
    const req = createBridgeRequest('discover', {});
    const res = {
      v: BRIDGE_PROTOCOL_VERSION,
      source: BRIDGE_SOURCE_ID,
      nonce: req.nonce,
      ok: true,
      result: { capabilities: [] },
    };
    expect(isBridgeResponse(res)).toBe(true);
    expect(validateBridgeResponse(res, req)).toEqual({
      ok: true,
      result: { capabilities: [] },
    });
    expect(isBridgeResponse({ ...res, source: 'other' })).toBe(false);
    expect(isBridgeResponse({ ...res, v: 2 })).toBe(false);
    expect(validateBridgeResponse(res, createBridgeRequest('save', {}))).toEqual({
      ok: false,
      error: 'NONCE_MISMATCH',
    });
  });

  it('validates error responses carrying a structured error code', () => {
    const req = createBridgeRequest('apply', {});
    const res = {
      v: BRIDGE_PROTOCOL_VERSION,
      source: BRIDGE_SOURCE_ID,
      nonce: req.nonce,
      ok: false,
      error: 'UNSUPPORTED_CAPABILITY',
    };
    expect(isBridgeResponse(res)).toBe(true);
    expect(validateBridgeResponse(res, req)).toEqual({
      ok: false,
      error: 'UNSUPPORTED_CAPABILITY',
    });
    expect(isBridgeResponse({ ...res, error: 42 })).toBe(false);
  });
});
