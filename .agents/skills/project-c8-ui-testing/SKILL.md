---
name: project-c8-ui-testing
description: Use c8 for headed Chrome, Playwright, and X11 acceptance of Symphony Board.
---

# c8 UI Testing

## Contract

Use the dedicated c8 test host for browser and whole-desktop acceptance. The
canonical tools, deployment, networking, and acceptance workflow belong to
`serenvia/c8-infra`.

## Entrypoint

Read `$HOME/Project/serenvia/c8-infra/.agents/skills/project-c8-ui-testing/SKILL.md`
and `docs/ui-automation.md` there. If that checkout is absent, fetch it or read
the same files from its provider; do not invent deployment commands.

## Workflow

1. Follow the canonical skill to verify SSH, X11, and tailnet connectivity.
2. Use `https://c8.tail841b2e.ts.net:8443/` for the c8 Board baseline. It serves
   this project's built UI and synthetic contract, without live provider sync
   or writer APIs. Tests needing APIs require their own isolated fixture backend.
3. Run feature-specific rendering, filtering, and navigation assertions on c8
   using its installed Chrome and Playwright. For a change under development,
   use a separate managed checkout and loopback port per the canonical skill.
4. Keep evidence private under `agent-out project`; report asserted behavior
   separately from infrastructure readiness.

## Boundary

UI testing does not authorize deployment, service restarts, provider mutation,
credential copying, or public listeners. This repo owns feature tests; c8-infra
owns installation and tailnet networking.
