# Reflex

A personal assistant you text. It has its own computer, your accounts, and a
memory, and it gets things done while you do something else: books the
dentist, lowers the cable bill, sweeps the inbox at 2pm, watches for tickets
and texts you the moment they're back.

Built on [Fountain](https://github.com/BinaryBourbon/fountain). Hosted at
[reflex.demo.managoat.com](https://reflex.demo.managoat.com).

## What it is, in Fountain terms

The page never sees an agent, a sandbox, a schedule or a vault. Reflex's own
server holds the person's Fountain key (sealed at rest), hires one persistent
agent per person, keeps one thread per person on the team channel, and
translates every Fountain concept into the owner's vocabulary:

| The owner sees | Fountain underneath |
|---|---|
| "Reflex" | one agent per person, `sandbox_mode: persistent`, on the team |
| the thread | the teammate's standing conversation; `blocks=true` folded server-side |
| Jobs | a ```` ```reflex ```` block the agent ends every reply with, parsed by the server's watcher (`shared/protocol.ts`), stored in Postgres |
| Memory | same block, `memory` key; long-form notes live on the agent's computer |
| Notifications | same block, `notify` key |
| Routines | `team.schedules` on the agent, prompts prefixed `[via routine]` |
| Texting | the team-comms contact (`POST /api/team/:id/contact`), gated on the `team_comms` flag |
| Accounts | a per-person vault; values write-only, labels in Postgres |
| Rules | guardrails compiled into the system prompt (`shared/spec.ts`) |

The watcher (`server/watcher.ts`) keeps one Fountain stream per person open
whether or not a browser is, so the board and the bell are right when you
come back. Messages sent while the assistant is busy queue in an outbox and
drain on the next `turn/done`.

## Run it

```sh
bun install
# Postgres somewhere, then:
DATABASE_URL=postgres://... REFLEX_SECRET=$(openssl rand -hex 32) bun run server   # :8080
bun run dev                                                                          # :5183, proxies /api
```

Sign in needs the `reflex` OAuth client registered on the Fountain you point
at, with `http://localhost:5183/` as a redirect URI (the hosted Fountain has
the production origin registered).

`bun test` runs the protocol, watcher and crypto tests; the store tests run
only with `TEST_DATABASE_URL` set (CI sets it).

## Ship

`build.yml` builds the SPA, pushes `ghcr.io/managoat/reflex` (amd64+arm64)
and pins the sha into `k8s/deployment.yaml`; Flux in `jhgaylor/home-cloud`
rolls it. The Bun image serves `dist/` and the API on one port. Postgres is a
CNPG cluster in the same namespace; `REFLEX_SECRET` comes from Infisical
(`/reflex`). One replica on purpose: watchers and the outbox drain assume a
single process.
