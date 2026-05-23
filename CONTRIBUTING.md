# Contributing

Thanks for considering contributing to openai-image-chat.

## Development setup

```bash
pnpm install
pnpm dev
pnpm server
```

Open the frontend at `http://127.0.0.1:5173`.

## Before submitting changes

Please run:

```bash
pnpm lint
pnpm build
```

## Pull request guidelines

- Keep changes focused and easy to review.
- Do not commit `.env`, API keys, logs, generated images, `node_modules`, or `dist`.
- Update `README.md` when behavior or configuration changes.
- Prefer small, explicit UI changes over broad rewrites.

## Security-sensitive changes

If a change touches API key handling, proxy behavior, file writing, or public networking, please document the security impact in the PR description.
