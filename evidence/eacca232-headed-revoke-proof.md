# t_eacca232 genuine headed C8 revoke proof — real unpacked MV3 extension, live Ghost 6.60

- headed Chromium under Xvfb display :102, --load-extension=/root/ghost-research/ghost-preset-toolbar/.worktrees/t_eacca232
- extension id: gajmcdfjpghaimgofcmnephkhpmfgifa
- Enable/Disable driven through the real setup page UI with OS-level trusted input;
  the native Chromium permission bubble was accepted by clicking its "Allow" button
  at real screen coordinates (top-chrome widget, not a JS dialog);
  native-consent screenshot artifact: /tmp/c8qa-consent-prompt.png
- registrations read from the real extension context via
  chrome.scripting.getRegisteredContentScripts(); capability tokens observed from the
  real production handshake are only compared by SHA-256 digest prefix and never printed.

- enable_native_consent_granted: true
- enable_two_registrations_exactly_scoped: true
- pre_disable_route_reached: true
- pre_disable_production_handshake_observed: true
- pre_disable_toolbar_mounted: true
- pre_disable_activated_discover_responds: true
- disable_via_real_setup_ui: true
- disable_registrations_empty: true
- post_disable_same_realm_silent: true
- stale_token_captured_from_real_handshake: true
- stale_token_rejected_silent: true
- fresh_doc_identity_distinct: true
- fresh_post_disable_no_toolbar: true
- fresh_post_disable_no_handshake: true
- fresh_post_disable_no_bridge_response: true
- re_enable_scoped_registrations_restored: true
- re_enable_toolbar_mounts: true
- re_enable_fresh_capability_token: true
- re_enable_new_handshake_discover_responds: true

All checks must be true for PROOF PASS. No cookie or token values appear in this file.
