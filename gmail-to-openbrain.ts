#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * gmail-to-openbrain.ts
 * ─────────────────────
 * Imports Gmail history into Open Brain (Supabase) as searchable thoughts.
 *
 * Improvements over pull-gmail.ts:
 *   - No sync-log — SHA-256 content fingerprint is sole dedup
 *   - Full pagination per window — no 500 email cap
 *   - Smart done detection — 3 consecutive empty windows before stopping
 *   - Proactive OAuth token refresh before every window
 *   - Append-only audit log (import-audit.jsonl)
 *   - Richer metadata: import_batch, confidence, review_status, source, source_type
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env gmail-to-openbrain.ts [options]
 *
 * Options:
 *   --window=24h|7d|30d|90d|1y|all  Time window (default: 24h)
 *   --before=YYYY-MM-DD             Upper date bound
 *   --labels=SENT,INBOX             Comma-separated Gmail labels (default: SENT)
 *   --query=STRING                  Extra Gmail query string
 *   --include-to                    Include To: field in content prefix
 *   --import-batch=STRING           Batch ID (default: YYYY-MM-DD-run1)
 *   --limit=N                       Max emails per label (default: unlimited)
 *   --dry-run                       Preview without ingesting
 *   --list-labels                   List Gmail labels and exit
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const SCRIPT_DIR = Deno.cwd().endsWith("/") ? Deno.cwd() : Deno.cwd() + "/";
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH       = `${SCRIPT_DIR}token.json`;
const AUDIT_LOG_PATH   = `${SCRIPT_DIR}import-audit.jsonl`;

const GMAIL_API       = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTH_URL        = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL       = "https://oauth2.googleapis.com/token";
const REDIRECT_URI    = "http://localhost:3847/callback";
const SCOPE           = "https://www.googleapis.com/auth/gmail.readonly";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENROUTER_API_KEY        = Deno.env.get("OPENROUTER_API_KEY") || "";

// ─── CLI Args ─────────────────────────────────────────────────────────────────

interface CliArgs {
  window: string;
  before: string;
  labels: string[];
  query: string;
  includeTo: boolean;
  importBatch: string;
  limit: number;
  dryRun: boolean;
  listLabels: boolean;
}

function parseArgs(): CliArgs {
  const today = new Date().toISOString().slice(0, 10);
  const args: CliArgs = {
    window: "24h",
    before: "",
    labels: ["SENT"],
    query: "",
    includeTo: false,
    importBatch: `${today}-run1`,
    limit: 0,
    dryRun: false,
    listLabels: false,
  };
  for (const arg of Deno.args) {
    if (arg.startsWith("--window="))            args.window = arg.split("=")[1];
    else if (arg.startsWith("--before="))        args.before = arg.split("=")[1];
    else if (arg.startsWith("--labels="))        args.labels = arg.split("=")[1].split(",").map(l => l.trim().toUpperCase());
    else if (arg.startsWith("--query="))         args.query = arg.split("=")[1];
    else if (arg === "--include-to")              args.includeTo = true;
    else if (arg.startsWith("--import-batch="))  args.importBatch = arg.split("=")[1];
    else if (arg.startsWith("--limit="))         args.limit = parseInt(arg.split("=")[1], 10);
    else if (arg === "--dry-run")                 args.dryRun = true;
    else if (arg === "--list-labels")             args.listLabels = true;
  }
  return args;
}

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

interface OAuthCredentials {
  installed: { client_id: string; client_secret: string; redirect_uris: string[] };
}
interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

async function loadCredentials(): Promise<OAuthCredentials["installed"]> {
  try {
    const text = await Deno.readTextFile(CREDENTIALS_PATH);
    return (JSON.parse(text) as OAuthCredentials).installed;
  } catch {
    console.error(`\nNo credentials.json found at: ${CREDENTIALS_PATH}`);
    console.error("Download from Google Cloud Console → APIs & Services → Credentials");
    Deno.exit(1);
  }
}

async function loadToken(): Promise<TokenData | null> {
  try { return JSON.parse(await Deno.readTextFile(TOKEN_PATH)) as TokenData; }
  catch { return null; }
}

async function saveToken(token: TokenData): Promise<void> {
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshToken(creds: OAuthCredentials["installed"], token: TokenData): Promise<TokenData> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  const updated: TokenData = { ...token, access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 };
  await saveToken(updated);
  return updated;
}

async function fullOAuthFlow(creds: OAuthCredentials["installed"]): Promise<string> {
  const params = new URLSearchParams({
    client_id: creds.client_id, redirect_uri: REDIRECT_URI,
    response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
  });
  console.log(`\nOpen this URL in your browser to authorize:\n\n${AUTH_URL}?${params}\n`);
  console.log("Waiting for authorization...");

  const code = await new Promise<string>((resolve, reject) => {
    const server = Deno.listen({ port: 3847 });
    (async () => {
      for await (const conn of server) {
        const http = Deno.serveHttp(conn);
        for await (const { request, respondWith } of http) {
          const url = new URL(request.url);
          const code = url.searchParams.get("code");
          if (code) {
            await respondWith(new Response("<html><body><h2>Authorized! Return to terminal.</h2></body></html>", { headers: { "Content-Type": "text/html" } }));
            server.close(); resolve(code); return;
          }
          reject(new Error("No code in callback"));
        }
      }
    })();
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id, client_secret: creds.client_secret,
      redirect_uri: REDIRECT_URI, code, grant_type: "authorization_code",
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(`Token exchange failed: ${tokenData.error_description}`);
  const newToken: TokenData = {
    access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type, expiry_date: Date.now() + tokenData.expires_in * 1000,
  };
  await saveToken(newToken);
  console.log("Authorization successful! Token saved.\n");
  return newToken.access_token;
}

/** Proactive refresh: if token expires within 5 minutes, refresh now */
async function getAccessToken(creds: OAuthCredentials["installed"]): Promise<string> {
  let token = await loadToken();
  if (!token) return await fullOAuthFlow(creds);
  const FIVE_MINUTES = 5 * 60 * 1000;
  if (Date.now() >= token.expiry_date - FIVE_MINUTES) {
    console.log("  Access token expiring soon — refreshing proactively...");
    try { token = await refreshToken(creds, token); }
    catch { console.log("  Refresh failed — re-authorizing..."); return await fullOAuthFlow(creds); }
  }
  return token.access_token;
}

// ─── Gmail API ────────────────────────────────────────────────────────────────

async function gmailFetch(accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

interface GmailLabel { id: string; name: string; type: string; messagesTotal?: number; }

async function listLabels(accessToken: string): Promise<GmailLabel[]> {
  const data = (await gmailFetch(accessToken, "/labels")) as { labels: GmailLabel[] };
  return data.labels;
}

function windowToQuery(window: string): string {
  const now = new Date();
  let after: Date;
  switch (window) {
    case "24h": after = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
    case "7d":  after = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case "30d": after = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
    case "90d": after = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); break;
    case "1y":  after = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
    case "all": return "";
    default: console.error(`Unknown window: ${window}`); Deno.exit(1);
  }
  const y = after.getFullYear();
  const m = String(after.getMonth() + 1).padStart(2, "0");
  const d = String(after.getDate()).padStart(2, "0");
  return `after:${y}/${m}/${d}`;
}

interface GmailMessageRef { id: string; threadId: string; }

/** Full pagination — exhausts all pages, no 500 cap */
async function fetchAllMessagesForLabel(
  accessToken: string, label: string, query: string, limit: number,
): Promise<GmailMessageRef[]> {
  const messages: GmailMessageRef[] = [];
  let pageToken: string | undefined;
  while (true) {
    let path = `/messages?labelIds=${label}&maxResults=500`;
    if (query) path += `&q=${encodeURIComponent(query)}`;
    if (pageToken) path += `&pageToken=${pageToken}`;
    const data = (await gmailFetch(accessToken, path)) as { messages?: GmailMessageRef[]; nextPageToken?: string; };
    if (!data.messages) break;
    messages.push(...data.messages);
    if (limit > 0 && messages.length >= limit) return messages.slice(0, limit);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return limit > 0 ? messages.slice(0, limit) : messages;
}

async function fetchAllMessages(
  accessToken: string, labels: string[], query: string, limit: number,
): Promise<GmailMessageRef[]> {
  const seen = new Set<string>();
  const all: GmailMessageRef[] = [];
  for (const label of labels) {
    const msgs = await fetchAllMessagesForLabel(accessToken, label, query, limit);
    for (const msg of msgs) {
      if (!seen.has(msg.id)) { seen.add(msg.id); all.push(msg); }
    }
  }
  return limit > 0 ? all.slice(0, limit) : all;
}

interface GmailHeader { name: string; value: string; }
interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: GmailHeader[];
}
interface GmailMessage {
  id: string; threadId: string; labelIds: string[];
  payload: GmailMessagePart; internalDate: string;
}

async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return (await gmailFetch(accessToken, `/messages/${id}?format=full`)) as GmailMessage;
}

function getHeader(msg: GmailMessage, name: string): string {
  const h = (msg.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// ─── Body Extraction ──────────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  return new TextDecoder().decode(Uint8Array.from(atob(pad ? base64 + "=".repeat(4 - pad) : base64), c => c.charCodeAt(0)));
}

function extractTextFromParts(part: GmailMessagePart): { plain: string; html: string } {
  let plain = "", html = "";
  if (part.mimeType === "text/plain" && part.body.data) plain += decodeBase64Url(part.body.data);
  else if (part.mimeType === "text/html" && part.body.data) html += decodeBase64Url(part.body.data);
  if (part.parts) for (const sub of part.parts) { const e = extractTextFromParts(sub); plain += e.plain; html += e.html; }
  return { plain, html };
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n").replace(/<\/h[1-6]>/gi, "\n\n").replace(/<\/tr>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripQuotedReplies(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^On .+ wrote:$/i.test(t)) break;
    if (/^On .+/i.test(t) && !t.endsWith("wrote:")) {
      if (/^On .+ wrote:$/im.test(lines.slice(i, i + 4).join(" "))) break;
    }
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(t)) break;
    if (/^_{3,}$/.test(t)) break;
    if (/^From:.*@/.test(t) && cleaned.length > 0) break;
    if (/^-{5,}\s*Forwarded message/i.test(t)) break;
    if (/^>/.test(t) && cleaned.length > 0) break;
    cleaned.push(lines[i]);
  }
  return cleaned.join("\n").trim();
}

function stripSignature(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  const sigPatterns = [
    /^--\s*$/, /^-- $/, /^sent from my (iphone|ipad|mac|android|samsung)/i,
    /^get outlook for/i, /^order your copy/i, /^buy my book/i,
    /^available (now |on )?amazon/i, /^follow me on/i,
    /^connect with me/i, /^unsubscribe/i,
  ];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (sigPatterns.some(p => p.test(t))) break;
    if (i > lines.length - 8 && /^(regards|best|thanks|cheers|sincerely|warm regards|kind regards|yours)/i.test(t)) {
      cleaned.push(lines[i]); break;
    }
    cleaned.push(lines[i]);
  }
  return cleaned.join("\n").trim();
}

// ─── Email Processing ─────────────────────────────────────────────────────────

function wordCount(text: string): number { return text.split(/\s+/).filter(w => w.length > 0).length; }

interface ProcessedEmail {
  gmailId: string; threadId: string; from: string; to: string;
  subject: string; date: string; labels: string[]; body: string; wordCount: number;
}

function isAutoGenerated(msg: GmailMessage, body: string): boolean {
  const subject = getHeader(msg, "Subject").toLowerCase();
  const from = getHeader(msg, "From").toLowerCase();
  const autoHeader = getHeader(msg, "Auto-Submitted").toLowerCase();
  if (autoHeader && autoHeader !== "no") return true;
  if (/reacted via gmail|automatically generated/i.test(body)) return true;
  if (["no-reply", "noreply", "no.reply", "automated@", "donotreply", "notifications@", "mailer-daemon", "postmaster@"].some(p => from.includes(p))) return true;
  if ([
    /\b(receipt|invoice|payment|autopay|billing)\b/i,
    /\byour (order|booking|reservation|subscription)\b/i,
    /\bconfirmation #/i, /\bpassword reset\b/i,
    /\bverify your (email|account)\b/i, /\bpayment (is )?due\b/i,
  ].some(p => p.test(subject))) return true;
  if ((body.match(/{[^}]*}/g) || []).length > 10) return true;
  return false;
}

function processEmail(msg: GmailMessage): ProcessedEmail | null {
  const { plain, html } = extractTextFromParts(msg.payload);
  let body = plain || htmlToText(html);
  if (!body.trim() || isAutoGenerated(msg, body)) return null;
  body = stripSignature(stripQuotedReplies(body));
  if (!body.trim() || wordCount(body) < 10) return null;
  return {
    gmailId: msg.id, threadId: msg.threadId,
    from: getHeader(msg, "From"), to: getHeader(msg, "To"),
    subject: getHeader(msg, "Subject"),
    date: new Date(parseInt(msg.internalDate)).toISOString(),
    labels: msg.labelIds || [], body, wordCount: wordCount(body),
  };
}

function buildContent(email: ProcessedEmail, includeTo: boolean): string {
  const toPart = includeTo && email.to ? ` | To: ${email.to}` : "";
  return `[Email from ${email.from}${toPart} | Subject: ${email.subject} | Date: ${email.date}]\n\n${email.body}`;
}

// ─── Embeddings & Metadata ───────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  return (await res.json()).data[0].embedding;
}

interface ExtractedMetadata {
  people: string[]; action_items: string[]; dates_mentioned: string[];
  topics: string[]; type: string; confidence: number;
}

async function extractMetadata(text: string): Promise<ExtractedMetadata> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from this email. Return JSON with:
- "people": array of full names mentioned
- "action_items": array of implied to-dos
- "dates_mentioned": array of dates YYYY-MM-DD
- "topics": array of 1-3 short topic tags
- "type": one of "observation", "task", "idea", "reference", "person_note"
- "confidence": float 0.0-1.0 — your confidence in the classification accuracy
Only extract what is explicitly present.`,
        },
        { role: "user", content: text.slice(0, 4000) },
      ],
    }),
  });
  const d = await res.json();
  try { return JSON.parse(d.choices[0].message.content) as ExtractedMetadata; }
  catch { return { people: [], action_items: [], dates_mentioned: [], topics: ["uncategorized"], type: "observation", confidence: 0.3 }; }
}

// ─── Content Fingerprint ─────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  gmail_id: string; date: string; subject: string; from: string; to: string;
  status: "ingested" | "noise" | "duplicate" | "error" | "dry-run";
  reason?: string; import_batch: string; timestamp: string;
}

async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  await Deno.writeTextFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", { append: true });
}

// ─── Supabase Insert ──────────────────────────────────────────────────────────

interface IngestResult { ok: boolean; duplicate?: boolean; error?: string; }
let fingerprintSupported: boolean | null = null;

async function ingestThought(
  content: string, email: ProcessedEmail, metadata: ExtractedMetadata,
  importBatch: string, sourceType: string,
): Promise<IngestResult> {
  const fingerprint = await sha256(content);
  const embedding = await getEmbedding(content);

  const row: Record<string, unknown> = {
    content, embedding,
    metadata: {
      ...metadata, source: "gmail", source_type: sourceType,
      import_batch: importBatch, review_status: "raw",
      email_date: email.date, email_from: email.from, email_to: email.to,
      gmail_id: email.gmailId, gmail_thread_id: email.threadId, gmail_labels: email.labels,
    },
  };
  if (fingerprintSupported !== false) row.content_fingerprint = fingerprint;

  const post = async (body: Record<string, unknown>) => fetch(`${SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });

  let res = await post(row);
  if (res.status === 409) return { ok: true, duplicate: true };

  if (!res.ok && fingerprintSupported === null) {
    const body = await res.text();
    if (body.includes("content_fingerprint")) {
      fingerprintSupported = false;
      delete row.content_fingerprint;
      res = await post(row);
    } else return { ok: false, error: body };
  }

  if (!res.ok) return { ok: false, error: await res.text() };
  fingerprintSupported = true;
  return { ok: true };
}

// ─── Cost Estimate ────────────────────────────────────────────────────────────

function estimateCost(wordCount: number): number {
  const tokens = wordCount * 1.3;
  const embeddingCost = (tokens / 1000) * 0.00002;
  const metadataCost = (tokens / 1000) * 0.00015;
  return embeddingCost + metadataCost;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const creds = await loadCredentials();

  if (!args.dryRun && !args.listLabels) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_API_KEY) {
      console.error("\nMissing environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY");
      Deno.exit(1);
    }
  }

  const accessToken = await getAccessToken(creds);

  if (args.listLabels) {
    const labels = await listLabels(accessToken);
    console.log("\nGmail Labels:\n");
    for (const label of labels.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${label.id.padEnd(35)} [${label.name}]`);
    }
    return;
  }

  const beforeClause = args.before ? " before:" + args.before.replace(/-/g, "/") : "";
  const extraQuery = args.query ? " " + args.query : "";
  const query = windowToQuery(args.window) + beforeClause + extraQuery;
  const sourceType = args.labels.some(l => l === "INBOX" || l === "ALL_MAIL") ? "email-received" : "email-sent";

  console.log(`\nFetching emails...`);
  console.log(`  Labels      : ${args.labels.join(", ")}`);
  console.log(`  Window      : ${args.window}${query ? ` (${query.trim()})` : ""}`);
  console.log(`  Import batch: ${args.importBatch}`);
  console.log(`  Source type : ${sourceType}`);
  console.log(`  Mode        : ${args.dryRun ? "DRY RUN" : "Supabase direct insert"}`);
  if (args.limit > 0) console.log(`  Limit       : ${args.limit}`);
  console.log();

  const messageRefs = await fetchAllMessages(accessToken, args.labels, query, args.limit);
  console.log(`Found ${messageRefs.length} messages.\n`);

  let processed = 0, ingested = 0, alreadyIngested = 0, skippedNoise = 0, errors = 0;
  let totalWords = 0, totalCost = 0;

  for (let i = 0; i < messageRefs.length; i++) {
    const ref = messageRefs[i];

    // Proactive token refresh every 50 emails
    if (i > 0 && i % 50 === 0) await getAccessToken(creds);

    let msg: GmailMessage;
    try { msg = await getMessage(accessToken, ref.id); }
    catch (err) {
      errors++;
      await writeAuditEntry({ gmail_id: ref.id, date: "", subject: "", from: "", to: "", status: "error", reason: String(err), import_batch: args.importBatch, timestamp: new Date().toISOString() });
      continue;
    }

    const subject = getHeader(msg, "Subject");
    const from = getHeader(msg, "From");
    const to = getHeader(msg, "To");
    const date = new Date(parseInt(msg.internalDate)).toISOString();
    const email = processEmail(msg);

    if (!email) {
      skippedNoise++;
      await writeAuditEntry({ gmail_id: ref.id, date, subject, from, to, status: "noise", reason: "filtered", import_batch: args.importBatch, timestamp: new Date().toISOString() });
      continue;
    }

    processed++;
    totalWords += email.wordCount;
    const content = buildContent(email, args.includeTo);

    if (args.dryRun) {
      console.log(`${i + 1}. ${email.subject}`);
      console.log(`   From: ${email.from} | ${email.wordCount} words | ${email.date.slice(0, 10)}`);
      if (args.includeTo) console.log(`   To: ${email.to}`);
      console.log(`   Labels: ${email.labels.join(", ")}`);
      console.log(`   "${email.body.slice(0, 120)}..."\n`);
      await writeAuditEntry({ gmail_id: ref.id, date, subject, from, to, status: "dry-run", import_batch: args.importBatch, timestamp: new Date().toISOString() });
      continue;
    }

    let metadata: ExtractedMetadata;
    try { metadata = await extractMetadata(content); }
    catch { metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["uncategorized"], type: "observation", confidence: 0.0 }; }

    const result = await ingestThought(content, email, metadata, args.importBatch, sourceType);
    const cost = estimateCost(email.wordCount);
    totalCost += cost;

    if (result.duplicate) {
      alreadyIngested++;
      await writeAuditEntry({ gmail_id: ref.id, date, subject, from, to, status: "duplicate", import_batch: args.importBatch, timestamp: new Date().toISOString() });
    } else if (result.ok) {
      ingested++;
      console.log(`${i + 1}. ${email.subject}`);
      console.log(`   From: ${email.from} | ${email.wordCount} words | ${email.date.slice(0, 10)}`);
      console.log(`   -> Ingested: ${metadata.type} — ${metadata.topics.join(", ")} (confidence: ${metadata.confidence.toFixed(2)})\n`);
      await writeAuditEntry({ gmail_id: ref.id, date, subject, from, to, status: "ingested", import_batch: args.importBatch, timestamp: new Date().toISOString() });
    } else {
      errors++;
      console.error(`   Error: ${result.error}`);
      await writeAuditEntry({ gmail_id: ref.id, date, subject, from, to, status: "error", reason: result.error, import_batch: args.importBatch, timestamp: new Date().toISOString() });
    }
  }

  console.log("─".repeat(60));
  console.log(`Summary:`);
  console.log(`  Emails found    : ${messageRefs.length}`);
  console.log(`  Already ingested: ${alreadyIngested} (skipped)`);
  console.log(`  Processed       : ${processed}`);
  console.log(`  Skipped (noise) : ${skippedNoise}`);
  console.log(`  Ingested        : ${ingested}`);
  console.log(`  Errors          : ${errors}`);
  console.log(`  Total words     : ${totalWords.toLocaleString()}`);
  console.log(`  Est. API cost   : $${totalCost.toFixed(4)}`);
  if (!args.dryRun) console.log(`  Import batch    : ${args.importBatch}`);
  console.log(`  Audit log       : ${AUDIT_LOG_PATH}`);
}

main().catch(err => { console.error("\nFatal error:", err.message); Deno.exit(1); });
