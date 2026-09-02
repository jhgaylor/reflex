# Reflex

A personal assistant you text. It has its own computer, your accounts, and a
memory, and it gets things done while you do something else: books the
dentist, lowers the cable bill, sweeps the inbox at 2pm, watches for tickets
and texts you the moment they're back.

Built on [Fountain](https://github.com/BinaryBourbon/fountain). Hosted at
[reflex.inevitable.fyi](https://reflex.inevitable.fyi).

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
| Memory | an [engram](https://github.com/engrambrain/engram) brain per person — a Postgres database of signed, decaying entries — served to the agent as MCP tools over `POST /api/mcp/memory` (`server/memory.ts` bridges HTTP to `engram mcp serve`'s stdio) and to the Memory page through the same CLI |
| Notifications | same block, `notify` key |
| Routines | `team.schedules` on the agent, prompts prefixed `[via routine]` |
| Texting | the team-comms contact (`POST /api/team/:id/contact`), gated on the `team_comms` flag |
| Personal Messages | a paired Mac relay; read-only `chat.db` queries and approval-gated Messages automation exposed to the agent through `/api/mcp/messages` |
| Signal | a paired signal-cli relay (linked device); relay-kept history and approval-gated sends exposed through `/api/mcp/signal` |
| Accounts | a per-person vault; values write-only, labels in Postgres |
| Rules | guardrails compiled into the system prompt (`shared/spec.ts`) |

The watcher (`server/watcher.ts`) keeps one Fountain stream per person open
whether or not a browser is, so the board and the bell are right when you
come back. Messages sent while the assistant is busy queue in an outbox and
drain on the next `turn/done`.

## Run it

```sh
bun install
# Postgres 17 with pgvector somewhere (memory creates one reflex_brain_<id>
# database per person, so the role needs CREATEDB + CREATEROLE), the engram
# binary on PATH (or ENGRAM_BIN), then:
DATABASE_URL=postgres://... REFLEX_SECRET=$(openssl rand -hex 32) bun run server   # :8080
bun run dev                                                                          # :5183, proxies /api
```

Without engram or pgvector the server still runs; the Memory page says
memory is not set up and agents get no memory tools. `REFLEX_PUBLIC_URL`
must point at the deployed origin or agents cannot reach their memory —
a sandbox cannot call your localhost.

Sign in needs the `reflex` OAuth client registered on the Fountain you point
at, with `http://localhost:5183/` as a redirect URI (the hosted Fountain has
the production origin registered).

`bun test` runs the protocol, watcher and crypto tests; the store tests run
only with `TEST_DATABASE_URL` set (CI sets it).

## Messages on a Mac (proof of concept)

Reflex can search the owner's local Messages history and send plain-text
replies through a paired Mac. The relay makes outbound HTTPS requests only;
the Mac opens no listening port and Reflex never receives an Apple password.

1. On the Mac, sign in to Messages. For carrier SMS/MMS/RCS, turn on Messages
   in iCloud or iPhone **Settings → Apps → Messages → Text Message Forwarding**
   for this Mac.
2. Give the terminal that runs Bun Full Disk Access in **System Settings →
   Privacy & Security → Full Disk Access**. Keep Messages open and the Mac
   awake.
3. Deploy/start this Reflex server with `REFLEX_PUBLIC_URL` set to its public
   HTTPS origin. The normal startup migration creates the pairing tables.
4. Open **Connections → Messages on your Mac → Pair a Mac**, then run the
   command it shows from this checkout. The one-time code expires after ten
   minutes. (The relay talks to `/api/relay/imessage/*`; the original
   `/api/messages/relay/*` spelling still works for relays started before it
   existed.)
5. Leave `bun run messages:relay` running. On the first actual send, macOS asks
   whether the process may control Messages; allow it.

Try “show me my five most recent Messages conversations” first. Sending uses
an existing conversation ID, and when “ask before sending” is on, Reflex must
get approval for the exact recipient and text before the relay accepts it.

The proof of concept reads ordinary `message.text` values. Rich attributed
messages may appear as `[rich or empty message]`, attachments are metadata
only, contacts are shown by the names stored on chats or their phone/email
handles, and the relay must be restarted manually after a Mac reboot.

## Signal (proof of concept)

The same relay transport carries Signal. The relay host runs
[signal-cli](https://github.com/AsamK/signal-cli) linked to the owner's phone
as a secondary device, so the Signal keys stay on that computer and Reflex only
sees what the relay answers. It does not need a Mac; any always-on machine
with Java works.

1. `brew install signal-cli qrencode` (or the equivalent for the host).
2. From this checkout run `bun run signal:relay -- --link`, then on the phone
   open **Signal → Settings → Linked devices → Link new device** and scan the
   QR code it prints.
3. Open **Connections → Signal → Pair a relay** in Reflex and run the command
   it shows on the relay host. Leave `bun run signal:relay` running.

signal-cli delivers each message once and keeps no history, so the relay
stores what it receives in `~/.local/share/reflex/signal-history.sqlite`.
History starts when the device was linked; messages the owner sends from
their phone arrive as sync messages and are stored too. Contact and group
names refresh every fifteen minutes. Reactions, receipts and group updates
are dropped; attachments are recorded as `[attachment]`.

## Ship

`build.yml` builds the SPA, pushes `ghcr.io/jhgaylor/reflex` (amd64+arm64)
and pins the sha into `k8s/deployment.yaml`; Flux in `jhgaylor/home-cloud`
rolls it. The Bun image serves `dist/` and the API on one port. Postgres is a
CNPG cluster in the same namespace; `REFLEX_SECRET` comes from Infisical
(`/reflex`). One replica on purpose: watchers and the outbox drain assume a
single process.
