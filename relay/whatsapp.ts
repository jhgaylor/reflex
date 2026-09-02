#!/usr/bin/env bun
/**
 * Reflex WhatsApp relay.
 *
 * Speaks the WhatsApp Web multi-device protocol through Baileys, linked to
 * the owner's phone as a companion device. Session keys stay in this host's
 * auth directory. Baileys keeps no message store, so the relay files what it
 * receives (including the history WhatsApp sends a freshly linked device) in
 * its own SQLite. It only makes outbound HTTPS requests to the Reflex server.
 *
 * Baileys is an unofficial client; WhatsApp's terms do not allow those. The
 * owner accepts that when they pair.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  useMultiFileAuthState,
  type Chat,
  type Contact,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { History } from "./history";
import { defaultConfigPath, errorText, loadPairing, makeUsage, parseArgs, required, serve, type Command } from "./transport";

const GROUP_REFRESH_MS = 15 * 60 * 1000;

const usage = makeUsage(`Usage:
  bun run relay/whatsapp.ts --link [--name "Reflex relay"]      link this host to your WhatsApp account (scan the QR code with your phone)
  bun run relay/whatsapp.ts --server https://reflex.example --code PAIRING_CODE [--name "Mac mini"]

After the first run, the saved pairing is used automatically:
  bun run relay/whatsapp.ts

Options: --auth DIR (session keys), --database PATH (message history), --config PATH`);

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2), usage);
  const authDir = args.auth ?? join(homedir(), ".local", "share", "reflex", "whatsapp-auth");
  const dbPath = args.database ?? join(homedir(), ".local", "share", "reflex", "whatsapp-history.sqlite");
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = new WhatsAppStore(dbPath);
  const wa = new WhatsApp(authDir, store);

  if (args.link) {
    await link(wa, store);
    if (!args.server) {
      console.log("Next: open Connections → WhatsApp → Pair a relay in Reflex and run the command it shows.");
      process.exit(0);
    }
  }

  const config = await loadPairing("whatsapp", args, args.config ?? defaultConfigPath("whatsapp"), usage);
  if (!(await wa.registered())) usage("This host is not linked to a WhatsApp account yet. Run with --link first.");
  await wa.connect();
  console.log(`Keeping WhatsApp history in ${dbPath}`);
  return serve("whatsapp", config, (command) => execute(command, store, wa), usage);
}

async function execute(command: Command, store: WhatsAppStore, wa: WhatsApp): Promise<unknown> {
  const limit = Math.max(1, Number(command.params.limit) || 20);
  if (command.method === "recent") return store.recent(Math.min(limit, 50));
  if (command.method === "thread") return store.thread(required(command.params.chat_id, "chat_id"), Math.min(limit, 100));
  if (command.method === "search") return store.search(required(command.params.query, "query"), Math.min(limit, 100));
  if (command.method === "send") {
    const chatId = required(command.params.chat_id, "chat_id");
    const text = required(command.params.text, "text");
    if (!store.knowsChat(chatId)) throw new Error("Unknown chat_id; use one returned by a read tool.");
    const sent = await wa.send(chatId, text);
    const at = toMillis(sent?.messageTimestamp) || Date.now();
    store.recordOwn(chatId, at, text, sent?.key?.id ? `${chatId}|${sent.key.id}` : undefined);
    return { sent: true, chat_id: chatId, at: new Date(at).toISOString() };
  }
  throw new Error(`unknown command ${String(command.method)}`);
}

// ── history ────────────────────────────────────────────────────────────────

export class WhatsAppStore extends History {
  /** Files a message from a live event or a history sync; system, reaction and poll messages are dropped. */
  ingest(m: WAMessage): void {
    const key = m.key;
    if (!key?.remoteJid || isJidStatusBroadcast(key.remoteJid) || key.remoteJid === "status@broadcast") return;
    const content = unwrap(m.message);
    if (!content) return;
    const chat = this.canon(key.remoteJid, key.remoteJidAlt);
    const isGroup = Boolean(isJidGroup(chat));
    const edit = content.protocolMessage?.editedMessage;
    if (edit && content.protocolMessage?.key?.id) {
      this.edit(`${chat}|${content.protocolMessage.key.id}`, describe(unwrap(edit)).text);
      return;
    }
    const { text, attachments, skip } = describe(content);
    if (skip) return;
    const fromMe = Boolean(key.fromMe);
    const sender = fromMe ? null : isGroup ? this.canon(key.participant ?? undefined, key.participantAlt) : chat;
    this.file(chat, isGroup, { at: toMillis(m.messageTimestamp) || Date.now(), text, attachments, id: key.id ? `${chat}|${key.id}` : undefined }, {
      fromMe,
      sender,
      senderName: fromMe ? null : (m.pushName ?? null),
    });
  }

  rememberContacts(rows: Array<Partial<Contact>>): void {
    for (const c of rows) {
      if (!c.id) continue;
      const name = c.name ?? c.verifiedName ?? c.notify ?? null;
      const phone = c.phoneNumber ? jidNormalizedUser(c.phoneNumber) : c.id.endsWith("@s.whatsapp.net") ? jidNormalizedUser(c.id) : null;
      this.rememberContact(jidNormalizedUser(c.id), phone, name);
      if (c.lid) this.rememberContact(jidNormalizedUser(c.lid), phone, name);
    }
  }

  rememberChats(rows: Chat[]): void {
    for (const c of rows) {
      if (!c.id || isJidStatusBroadcast(c.id)) continue;
      const loose = c as Chat & { displayName?: string | null; pnJid?: string | null; lidJid?: string | null };
      const name = c.name ?? loose.displayName ?? null;
      if (isJidGroup(c.id)) this.rememberGroup(c.id, name);
      else {
        const phone = loose.pnJid ? jidNormalizedUser(loose.pnJid) : c.id.endsWith("@s.whatsapp.net") ? jidNormalizedUser(c.id) : null;
        this.rememberContact(jidNormalizedUser(c.id), phone, name);
        if (loose.lidJid) this.rememberContact(jidNormalizedUser(loose.lidJid), phone, name);
      }
    }
  }

  rememberLidMappings(rows: Array<{ lid: string; pn: string }>): void {
    for (const r of rows) this.rememberContact(jidNormalizedUser(r.lid), jidNormalizedUser(r.pn), null);
  }

  rememberGroups(rows: Array<{ id: string; subject?: string | null }>): void {
    for (const g of rows) if (g.id) this.rememberGroup(g.id, g.subject ?? null);
  }

  /** The phone-number JID when known (the key's alternate, or a stored LID mapping), else the JID as given. */
  private canon(jid: string | null | undefined, alt: string | null | undefined): string {
    const id = jidNormalizedUser(jid ?? "");
    if (!id.endsWith("@lid")) return id;
    if (alt) {
      const phone = jidNormalizedUser(alt);
      this.rememberContact(id, phone, null);
      return phone;
    }
    return this.resolve(id);
  }
}

type Content = NonNullable<WAMessage["message"]>;

/** Peels the wrappers WhatsApp puts around ordinary content (ephemeral, view-once, captions). */
function unwrap(message: WAMessage["message"] | undefined): Content | null {
  let m: Content | null | undefined = message;
  for (let i = 0; m && i < 5; i += 1) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m ?? null;
}

/** Plain text for what the message carries; `skip` for things that are not messages to a reader. */
function describe(c: Content | null): { text: string | null; attachments: number; skip: boolean } {
  if (!c) return { text: null, attachments: 0, skip: true };
  if (c.conversation) return { text: c.conversation, attachments: 0, skip: false };
  if (c.extendedTextMessage?.text) return { text: c.extendedTextMessage.text, attachments: 0, skip: false };
  const media = c.imageMessage ?? c.videoMessage ?? c.documentMessage;
  if (media) return { text: media.caption ?? null, attachments: 1, skip: false };
  if (c.audioMessage) return { text: c.audioMessage.ptt ? "[voice note]" : "[audio]", attachments: 1, skip: false };
  if (c.stickerMessage) return { text: "[sticker]", attachments: 1, skip: false };
  if (c.locationMessage || c.liveLocationMessage) return { text: "[location]", attachments: 1, skip: false };
  if (c.contactMessage || c.contactsArrayMessage) return { text: "[contact card]", attachments: 1, skip: false };
  if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3) return { text: `[poll] ${(c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3)?.name ?? ""}`.trim(), attachments: 0, skip: false };
  return { text: null, attachments: 0, skip: true };
}

function toMillis(ts: WAMessage["messageTimestamp"] | undefined): number {
  if (ts === null || ts === undefined) return 0;
  const n = typeof ts === "number" ? ts : Number(ts.toString());
  return Number.isFinite(n) ? n * 1000 : 0;
}

// ── the socket ─────────────────────────────────────────────────────────────

/** One Baileys connection that files everything into the store and reconnects until it is logged out. */
class WhatsApp {
  private sock: WASocket | null = null;
  private ready: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | null = null;
  private everOpened = false;

  constructor(
    private authDir: string,
    private store: WhatsAppStore,
  ) {}

  /** Baileys never flips `creds.registered`; a linked session is one that knows who it is. */
  async registered(): Promise<boolean> {
    const { state } = await useMultiFileAuthState(this.authDir);
    return Boolean(state.creds.me?.id);
  }

  /** Resolves once the socket is open; keeps reconnecting in the background afterwards. */
  connect(onQr?: (qr: string) => void): Promise<void> {
    if (!this.ready) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.ready = { promise, resolve, reject };
      void this.open(onQr);
    }
    return this.ready.promise;
  }

  async send(chatId: string, text: string): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error("WhatsApp is reconnecting; try again in a moment.");
    return this.sock.sendMessage(chatId, { text });
  }

  private async open(onQr?: (qr: string) => void): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Reflex"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings }) => {
      this.store.rememberLidMappings(lidPnMappings ?? []);
      this.store.rememberContacts(contacts);
      this.store.rememberChats(chats);
      for (const m of messages) this.store.ingest(m);
    });
    sock.ev.on("contacts.upsert", (rows) => this.store.rememberContacts(rows));
    sock.ev.on("contacts.update", (rows) => this.store.rememberContacts(rows));
    sock.ev.on("chats.upsert", (rows) => this.store.rememberChats(rows));
    sock.ev.on("groups.upsert", (rows) => this.store.rememberGroups(rows));
    sock.ev.on("groups.update", (rows) => this.store.rememberGroups(rows.filter((g): g is { id: string; subject?: string } => Boolean(g.id))));
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) {
        try {
          this.store.ingest(m);
        } catch (err) {
          console.error(`could not store a message: ${errorText(err)}`);
        }
      }
    });

    let groupTimer: ReturnType<typeof setInterval> | null = null;
    const refreshGroups = async () => {
      try {
        const groups = await sock.groupFetchAllParticipating();
        this.store.rememberGroups(Object.values(groups));
      } catch (err) {
        console.error(`could not refresh WhatsApp groups: ${errorText(err)}`);
      }
    };

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr && onQr) onQr(qr);
      if (connection === "open") {
        this.everOpened = true;
        this.ready?.resolve();
        console.log("WhatsApp connected.");
        void refreshGroups();
        groupTimer ??= setInterval(refreshGroups, GROUP_REFRESH_MS);
        groupTimer.unref();
      }
      if (connection === "close") {
        if (groupTimer) clearInterval(groupTimer);
        this.sock = null;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          const msg = "WhatsApp logged this device out. Remove the auth directory and run --link again.";
          if (this.everOpened) usage(msg);
          this.ready?.reject(new Error(msg));
          return;
        }
        // WhatsApp always drops a freshly paired socket with 515 and expects an immediate reconnect.
        const restart = code === DisconnectReason.restartRequired;
        if (!restart && !this.everOpened) {
          this.ready?.reject(new Error(`WhatsApp closed the connection (${code ?? "unknown"}): ${errorText(lastDisconnect?.error)}`));
          return;
        }
        const delay = restart ? 500 : 5000;
        console.error(`${new Date().toISOString()} WhatsApp ${restart ? "asked for a restart" : `disconnected (${code ?? "unknown"})`}; reconnecting`);
        setTimeout(() => void this.open(onQr), delay);
      }
    });
  }
}

// ── setup helpers ──────────────────────────────────────────────────────────

/** Shows the QR, waits for the phone to link, then stays up long enough to catch the initial history sync. */
async function link(wa: WhatsApp, store: WhatsAppStore): Promise<void> {
  if (await wa.registered()) {
    console.log("This host is already linked to WhatsApp.");
    return;
  }
  let shown = false;
  await wa.connect((qr) => {
    if (!shown) console.log("On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan:\n");
    shown = true;
    qrcode.generate(qr, { small: true });
  });
  console.log("Linked. Waiting for WhatsApp to send recent history (up to 90s)…");
  const before = store.recent(1).length;
  const start = Date.now();
  let quietSince = Date.now();
  let last = 0;
  while (Date.now() - start < 90_000) {
    await Bun.sleep(2000);
    const count = store.recent(50).length;
    if (count !== last) {
      last = count;
      quietSince = Date.now();
    } else if (count > before && Date.now() - quietSince > 15_000) break;
  }
  console.log(`History sync done: ${store.recent(50).length} recent conversations on file.`);
}

if (import.meta.main) await main();
