# Security Policy

## Supported versions

This project is currently maintained on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue with secrets, private API keys, or exploit details.

If you discover a vulnerability, report it privately to the repository maintainer. Include:

- affected version or commit
- reproduction steps
- expected impact
- any suggested mitigation

## Security notes for users

- Do not commit `.env` or API keys.
- Do not expose this service directly to the public internet without authentication, HTTPS, and rate limiting.
- Treat the local proxy as trusted-network software by default.
- If multiple people can access the service, prefer server-side API key configuration and avoid typing keys into shared browsers.
- Review `OPENCLAW_IMAGE_OUTPUT_DIR` or any custom output directory before enabling public access to saved files.
