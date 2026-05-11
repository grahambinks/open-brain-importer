#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * list-senders.ts
 * ───────────────
 * Scans your Gmail received history and produces a ranked list of senders.
 * Read-only — no Supabase calls, no embeddings, zero API cost.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env list-senders.ts
 *   deno run --allow-net --allow-read --allow-write --allow-env list-senders.ts --years=5
 *   deno run --allow-net --allow-read --allow-write --allow-env list-senders.ts --years=5 --to=grahambinks@gmail.com
 *
 * Outputs:
 *   - Terminal: ranked sender table grouped by domain
 *   - senders-raw.txt: paste into Notion Approved Senders Checklist
 */

// ── Config ────────────────────────────────────────────────────────────────────

const CREDENTIALS_FILE = "./credentials.json";
const TOKEN_FILE = "./token.json";
const OUTPUT_FILE = "./senders-raw.txt";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://localhost:3847/callback";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// ── CLI Args ──────────────────────────────────────────────────────────────────

interface CliArgs {
  years: number;
  to: string;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { years: 5, to: "" };
  for (const arg of Deno.args) {
    if (arg.startsWith("--years=")) args.years = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--to=")) args.to = arg.split("=")[1];
  }
  return args;
}

// ── Token Management (reuses existing token.json) ─────────────────────────────

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

interface Credentials {
  installed: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

async function loadCredentials(): Promise<Credentials["installed"]> {
  try {
    const raw = await Deno.readTextFile(CREDENTIALS_FILE);
    const creds = JSON.parse(raw) as Credentials;
    return creds.installed;
  } catch {
    console.error(`\nCannot read ${CREDENTIALS_FILE}`);
    console.error("Make sure credentials.json is in the current directory.\n");
    Deno.exit(1);
  }
}

async function loadToken(): Promise<TokenData | null> {
  try {
    const raw = await Deno.readTextFile(TOKEN_FILE);
    return JSON.parse(raw) as TokenData;
  } catch {
    return null;
  }
}

async function saveToken(token: TokenData): Promise<void> {
  await Deno.writeTextFile(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function refreshAccessToken(
  creds: Credentials["installed"],
  token: TokenData,
): Promise<TokenData> {
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
  const updated: TokenData = {
    ...token,
    access_token: data.access_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await saveToken(updated);
  return updated;
}

async function authorize(creds: Credentials["installed"]): Promise<string> {
  let token = await loadToken();

  if (token) {
    if (Date.now() < token.expiry_date - 60_000) return token.access_token;
    token = await refreshAccessToken(creds, token);
    return token.access_token;
  }

  // Full OAuth flow
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
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
            await respondWith(
              new Response("<html><body><h2>Authorized! Return to terminal.</h2></body></html>", {
                headers: { "Content-Type": "text/html" },
              }),
            );
            server.close();
            resolve(code);
            return;
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
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: REDIRECT_URI,
      code,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(`Token exchange failed: ${tokenData.error_description}`);

  const newToken: TokenData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  };
  await saveToken(newToken);
  console.log("Authorization successful!\n");
  return newToken.access_token;
}

// ── Gmail API ─────────────────────────────────────────────────────────────────

async function gmailFetch(accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${body}`);
  }
  return res.json();
}

interface MessageRef { id: string; threadId: string; }

async function fetchMessageRefs(
  accessToken: string,
  query: string,
): Promise<MessageRef[]> {
  const refs: MessageRef[] = [];
  let pageToken: string | undefined;
  let page = 0;

  while (true) {
    page++;
    let path = `/messages?maxResults=500&q=${encodeURIComponent(query)}`;
    if (pageToken) path += `&pageToken=${pageToken}`;

    const data = (await gmailFetch(accessToken, path)) as {
      messages?: MessageRef[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    };

    if (page === 1) {
      const est = data.resultSizeEstimate || 0;
      console.log(`  Estimated messages: ~${est.toLocaleString()}`);
    }

    if (!data.messages) break;
    refs.push(...data.messages);
    process.stdout.write(`\r  Fetched message IDs: ${refs.length.toLocaleString()}...`);

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  console.log(`\r  Fetched message IDs: ${refs.length.toLocaleString()} ✓`);
  return refs;
}

interface MessageDetail {
  id: string;
  payload: {
    headers: { name: string; value: string }[];
  };
}

async function getFromHeader(accessToken: string, id: string): Promise<string> {
  const msg = (await gmailFetch(
    accessToken,
    `/messages/${id}?format=metadata&metadataHeaders=From`,
  )) as MessageDetail;
  const fromHeader = msg.payload.headers.find(
    (h) => h.name.toLowerCase() === "from",
  );
  return fromHeader?.value || "";
}

// ── Sender Parsing ────────────────────────────────────────────────────────────

function parseEmail(from: string): { name: string; email: string; domain: string } {
  const emailMatch = from.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
  const nameMatch = from.match(/^([^<]+)</);
  const name = nameMatch ? nameMatch[1].trim().replace(/"/g, "") : "";
  const domainMatch = email.match(/@(.+)$/);
  const domain = domainMatch ? domainMatch[1] : "unknown";
  return { name, email, domain };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const creds = await loadCredentials();
  const accessToken = await authorize(creds);

  // Build query
  const afterDate = new Date();
  afterDate.setFullYear(afterDate.getFullYear() - args.years);
  const y = afterDate.getFullYear();
  const m = String(afterDate.getMonth() + 1).padStart(2, "0");
  const d = String(afterDate.getDate()).padStart(2, "0");
  const afterStr = `${y}/${m}/${d}`;

  const toClause = args.to ? ` to:${args.to}` : "";
  const query = `after:${afterStr}${toClause} -from:me`;

  console.log(`\nScanning Gmail for received emails...`);
  console.log(`  Date range : last ${args.years} years (after ${afterStr})`);
  if (args.to) console.log(`  To         : ${args.to}`);
  console.log(`  Query      : ${query}\n`);

  // Fetch all message refs
  const refs = await fetchMessageRefs(accessToken, query);

  if (refs.length === 0) {
    console.log("\nNo messages found. Check your --to= address or --years= range.");
    Deno.exit(0);
  }

  // Fetch From headers with progress
  console.log(`\n  Fetching sender details (this takes a few minutes)...`);
  const senderMap = new Map<string, { name: string; email: string; domain: string; count: number }>();
  let processed = 0;
  const BATCH = 10;

  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (ref) => {
        try {
          const from = await getFromHeader(accessToken, ref.id);
          const parsed = parseEmail(from);
          if (!parsed.email || parsed.email.includes("@")) {
            const key = parsed.email;
            if (senderMap.has(key)) {
              senderMap.get(key)!.count++;
            } else {
              senderMap.set(key, { ...parsed, count: 1 });
            }
          }
        } catch {
          // skip individual failures silently
        }
        processed++;
      }),
    );
    process.stdout.write(
      `\r  Processing: ${processed.toLocaleString()} / ${refs.length.toLocaleString()} (${Math.round((processed / refs.length) * 100)}%)`,
    );
  }

  console.log(`\r  Processing: ${processed.toLocaleString()} / ${refs.length.toLocaleString()} ✓\n`);

  // Group by domain
  const domainMap = new Map<string, { senders: typeof senderMap extends Map<string, infer V> ? V[] : never; total: number }>();
  for (const sender of senderMap.values()) {
    if (!domainMap.has(sender.domain)) {
      domainMap.set(sender.domain, { senders: [], total: 0 });
    }
    const d = domainMap.get(sender.domain)!;
    d.senders.push(sender as never);
    d.total += sender.count;
  }

  // Sort domains by total count
  const sortedDomains = [...domainMap.entries()].sort((a, b) => b[1].total - a[1].total);

  // ── Terminal Output ──────────────────────────────────────────────────────────

  console.log("═".repeat(70));
  console.log(`SENDER SUMMARY — last ${args.years} years (${refs.length.toLocaleString()} emails)`);
  console.log("═".repeat(70));
  console.log(`${"Count".padStart(6)}  ${"Domain".padEnd(30)}  Top Sender`);
  console.log("─".repeat(70));

  for (const [domain, { senders, total }] of sortedDomains) {
    const top = (senders as { name: string; email: string; count: number }[])
      .sort((a, b) => b.count - a.count)[0];
    const topStr = top.name ? `${top.name} <${top.email}>` : top.email;
    console.log(`${String(total).padStart(6)}  ${domain.padEnd(30)}  ${topStr.slice(0, 30)}`);
  }

  console.log("─".repeat(70));
  console.log(`${String(refs.length).padStart(6)}  TOTAL\n`);

  // ── File Output ──────────────────────────────────────────────────────────────

  const lines: string[] = [
    `SENDER SUMMARY — last ${args.years} years (${refs.length.toLocaleString()} emails)`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `${"Count".padStart(6)}  ${"Domain".padEnd(30)}  ${"Top Sender".padEnd(40)}  All Senders`,
    "─".repeat(120),
  ];

  for (const [domain, { senders, total }] of sortedDomains) {
    const sorted = (senders as { name: string; email: string; count: number }[])
      .sort((a, b) => b.count - a.count);
    const top = sorted[0];
    const topStr = top.name ? `${top.name} <${top.email}>` : top.email;
    const others = sorted
      .slice(1, 4)
      .map((s) => `${s.email}(${s.count})`)
      .join(", ");
    lines.push(
      `${String(total).padStart(6)}  ${domain.padEnd(30)}  ${topStr.padEnd(40)}  ${others}`,
    );
  }

  await Deno.writeTextFile(OUTPUT_FILE, lines.join("\n") + "\n");
  console.log(`✅ Full sender list written to: ${OUTPUT_FILE}`);
  console.log(`   Paste contents into Notion Approved Senders Checklist.\n`);
}

main().catch((err) => {
  console.error("\nError:", err.message);
  Deno.exit(1);
});
