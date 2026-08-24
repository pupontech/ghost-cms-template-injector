# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`. This is currently a private pre-1.0 project.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials, private Ghost content, or exploit material. Use GitHub's private vulnerability reporting/security advisory feature for this repository, or contact the repository owner privately.

Include:

- Affected commit and Chromium/Ghost versions
- Reproduction steps using sanitized values
- Security impact
- Suggested mitigation, if known

Never include cookies, passwords, API tokens, CSRF values, TLS private keys, complete request headers, private post content, or an authenticated browser profile.

## Security properties

The extension is designed to:

- Request no static host permission.
- Obtain explicit native consent for one HTTPS Ghost installation.
- Dynamically scope scripts to that installation's `/ghost/*` pages.
- Keep the MAIN-world bridge dormant unless activated with a per-enable capability.
- Reject stale capabilities after Disable/re-enable.
- Store presets locally and avoid storing Ghost credentials.
- Execute no remotely hosted code.

A report showing any violation of these properties should be treated as security-sensitive.
