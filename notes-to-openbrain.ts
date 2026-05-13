#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * notes-to-openbrain.ts
 * ─────────────────────
 * Imports exported Apple Notes (.md files) into Open Brain (Supabase) as searchable thoughts.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env notes-to-openbrain.ts [options]
 *
 * Options:
 *   --folder=NAME         Import only files in this subfolder of mdInbox
 *   --dry-run             Preview without ingesting, no files moved
 *   --confirm             Show file count and ask Y/N before ingesting
 *   --sample=N            Pick N random files for preview/processing
 *   --limit=N             Max files to process (default: unlimited)
 *   --import-batch=STR    Batch ID (default: YYYY-MM-DD-run1)
 *   --min-words=N         Skip files under N words (default: 2)
 *   --concurrency=N       Parallel files to process (default: 5)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const SCRIPT_DIR     = Deno.cwd().endsWith("/") ? Deno.cwd() : Deno.cwd() + "/";
const INBOX_DIR      = `${SCRIPT_DIR}mdInbox/`;
const DONE_DIR       = `${SCRIPT_DIR}mdDone/`;
const AUDIT_LOG_PATH = `${SCRIPT_DIR}import-audit.jsonl`;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENROUTER_API_KEY        = Deno.env.get("OPENROUTER_API_KEY") || "";

// ─── CLI Args ─────────────────────────────────────────────────────────────────

interface CliArgs {
  folder: string;
  dryRun: boolean;
  confirm: boolean;
  sample: number;
  limit: number;
  importBatch: string;
  minWords: number;
  concurrency: number;
}

function parseArgs(): CliArgs {
  const today = new Date().toISOString().slice(0, 10);
  const args: CliArgs = {
    folder: "",
    dryRun: false,
    confirm: false,
    sample: 0,
    limit: 0,
    importBatch: `${today}-run1`,
    minWords: 2,
    concurrency: 5,
  };
  for (const arg of Deno.args) {
    if (arg === "--dry-run")                    args.dryRun = true;
    else if (arg === "--confirm")               args.confirm = true;
    else if (arg.startsWith("--folder="))       args.folder = arg.split("=")[1];
    else if (arg.startsWith("--sample="))       args.sample = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--limit="))        args.limit = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--import-batch=")) args.importBatch = arg.split("=")[1];
    else if (arg.startsWith("--min-words="))    args.minWords = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--concurrency="))  args.concurrency = parseInt(arg.split("=")[1], 10);
  }
  return args;
}

// ─── File Discovery ───────────────────────────────────────────────────────────

interface NoteFile {
  absPath: string;
  relPath: string;   // e.g. "Music/guitar-ideas.md"
  folder: string;    // top-level subfolder, e.g. "Music"
  filename: string;  // e.g. "guitar-ideas.md"
  title: string;     // e.g. "guitar-ideas"
}

async function discoverFiles(folder: string): Promise<NoteFile[]> {
  const files: NoteFile[] = [];

  async function scan(dir: string, relDir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) {
          if (entry.name === "_Deleted") continue;
          const newRelDir = relDir ? `${relDir}/${entry.name}` : entry.name;
          await scan(`${dir}${entry.name}/`, newRelDir);
        } else if (entry.isFile && entry.name.endsWith(".md")) {
          const topFolder = relDir.split("/")[0] || "";
          if (folder && topFolder.toLowerCase() !== folder.toLowerCase()) continue;
          const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
          files.push({
            absPath: `${dir}${entry.name}`,
            relPath,
            folder: topFolder,
            filename: entry.name,
            title: entry.name.replace(/\.md$/, ""),
          });
        }
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
  }

  try {
    await Deno.stat(INBOX_DIR);
  } catch {
    console.error(`\nmdInbox not found at: ${INBOX_DIR}`);
    console.error("Create it with: mkdir -p ~/MyOpenBrain/mdInbox");
    Deno.exit(1);
  }

  await scan(INBOX_DIR, "");
  return files;
}

// ─── Text Helpers ─────────────────────────────────────────────────────────────

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function extractAttachments(body: string): string[] {
  const seen = new Set<string>();
  const attachments: string[] = [];
  for (const match of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const src = match[1];
    const basename = src.includes("/") ? src.split("/").pop()! : src;
    if (!seen.has(basename)) { seen.add(basename); attachments.push(basename); }
  }
  return attachments;
}

function isNoise(body: string, minWords: number): { noise: boolean; reason?: string } {
  const trimmed = body.trim();
  if (!trimmed) return { noise: true, reason: "empty" };
  if (wordCount(trimmed) < minWords) return { noise: true, reason: `under ${minWords} words` };
  if (/^https?:\/\/\S+$/.test(trimmed)) return { noise: true, reason: "url-only" };
  if (/^\d{1,4}[-\/\.]\d{1,2}[-\/\.]\d{1,4}$/.test(trimmed)) return { noise: true, reason: "date-only" };
  if (/^\d+(\.\d+)?$/.test(trimmed)) return { noise: true, reason: "number-only" };
  return { noise: false };
}

function buildContent(note: NoteFile, body: string, attachments: string[], modifiedDate: string): string {
  const modDate = modifiedDate.slice(0, 10);
  let prefix = `[Note: ${note.relPath} | Modified: ${modDate}]`;
  for (const att of attachments) prefix += `\n[Attachment: ${att}]`;
  return `${prefix}\n\n${body}`;
}

function estimateCost(wc: number): number {
  const tokens = wc * 1.3;
  return (tokens / 1000) * 0.00002 + (tokens / 1000) * 0.00015;
}

// ─── SHA-256 ──────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── OpenRouter API ───────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

interface ExtractedMetadata {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: string;
  confidence: number;
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
          content: `Extract metadata from this note. Return JSON with:
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
  try {
    const parsed = JSON.parse(d.choices[0].message.content);
    if (!parsed || typeof parsed !== "object") throw new Error("null or invalid metadata response");
    return {
      people: parsed.people ?? [],
      action_items: parsed.action_items ?? [],
      dates_mentioned: parsed.dates_mentioned ?? [],
      topics: parsed.topics ?? ["uncategorized"],
      type: parsed.type ?? "observation",
      confidence: parsed.confidence ?? 0.3,
    };
  } catch {
    return { people: [], action_items: [], dates_mentioned: [], topics: ["uncategorized"], type: "observation", confidence: 0.3 };
  }
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

function sbHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

async function findExisting(filename: string): Promise<{ id: string; content_fingerprint: string | null } | null> {
  const url = `${SUPABASE_URL}/rest/v1/thoughts?select=id,content_fingerprint&metadata->>note_filename=eq.${encodeURIComponent(filename)}`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json() as { id: string; content_fingerprint: string | null }[];
  return rows.length > 0 ? rows[0] : null;
}

async function deleteThought(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/thoughts?id=eq.${id}`, {
    method: "DELETE",
    headers: sbHeaders(),
  });
}

interface IngestResult { ok: boolean; duplicate?: boolean; error?: string; }

async function insertThought(
  content: string, embedding: number[], fingerprint: string,
  note: NoteFile, metadata: ExtractedMetadata,
  attachments: string[], mtime: string, args: CliArgs,
): Promise<IngestResult> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({
      content,
      embedding,
      content_fingerprint: fingerprint,
      metadata: {
        ...metadata,
        source: "apple-notes",
        source_type: note.folder === "QuickNotes" ? "quick-note" : "note",
        note_filename: note.filename,
        note_folder: note.folder,
        note_modified: mtime,
        attachments,
        import_batch: args.importBatch,
        review_status: "raw",
      },
    }),
  });
  if (res.status === 409) return { ok: true, duplicate: true };
  if (res.ok) return { ok: true };
  return { ok: false, error: await res.text() };
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  date: string;
  title: string;
  status: "ingested" | "noise" | "duplicate" | "error" | "dry-run";
  reason?: string;
  import_batch: string;
  timestamp: string;
}

async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  await Deno.writeTextFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", { append: true });
}

// ─── Concurrency Pool ─────────────────────────────────────────────────────────

async function runWithConcurrency(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
  const queue = [...tasks];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      await queue.shift()!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Stats ────────────────────────────────────────────────────────────────────

interface Stats {
  filesFound: number;
  processed: number;
  ingested: number;
  duplicate: number;
  noise: number;
  errors: number;
  movedToDone: number;
  totalWords: number;
  totalCost: number;
  dryRunCounter: number;
}

// ─── Process Single Note ──────────────────────────────────────────────────────

async function processNote(note: NoteFile, args: CliArgs, stats: Stats): Promise<void> {
  let rawBodyRaw: string;
  let mtime: string;
  try {
    rawBodyRaw = await Deno.readTextFile(note.absPath);
    mtime = (await Deno.stat(note.absPath)).mtime?.toISOString() ?? new Date().toISOString();
  } catch (err) {
    stats.errors++;
    await writeAuditEntry({ id: note.filename, date: "", title: note.title, status: "error", reason: String(err), import_batch: args.importBatch, timestamp: new Date().toISOString() });
    return;
  }

  const rawBody = stripHtml(rawBodyRaw);
  const noiseCheck = isNoise(rawBody, args.minWords);
  if (noiseCheck.noise) {
    stats.noise++;
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "noise", reason: noiseCheck.reason, import_batch: args.importBatch, timestamp: new Date().toISOString() });
    return;
  }

  const attachments = extractAttachments(rawBody);
  const wc = wordCount(rawBody);
  stats.processed++;
  stats.totalWords += wc;

  if (args.dryRun) {
    const n = ++stats.dryRunCounter;
    console.log(`${n}. ${note.filename}`);
    console.log(`   Folder  : ${note.folder || "(root)"}`);
    console.log(`   Words   : ${wc}`);
    console.log(`   Modified: ${mtime.slice(0, 10)}`);
    console.log(`   Preview : "${rawBody.trim().slice(0, 100)}..."\n`);
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "dry-run", import_batch: args.importBatch, timestamp: new Date().toISOString() });
    return;
  }

  const content = buildContent(note, rawBody, attachments, mtime);
  const fingerprint = await sha256(content);

  // Update detection: check for existing record by note_filename
  let existingId: string | null = null;
  try {
    const existing = await findExisting(note.filename);
    if (existing) {
      if (existing.content_fingerprint === fingerprint) {
        // Content unchanged — skip without burning API credits
        stats.duplicate++;
        await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "duplicate", import_batch: args.importBatch, timestamp: new Date().toISOString() });
        return;
      }
      // Content changed — delete old record before re-inserting
      existingId = existing.id;
      await deleteThought(existingId);
    }
  } catch (err) {
    console.error(`  Warning: update check failed for ${note.filename}: ${err}`);
  }

  let metadata: ExtractedMetadata;
  try {
    metadata = await extractMetadata(content);
  } catch {
    metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["uncategorized"], type: "observation", confidence: 0.3 };
  }

  let embedding: number[];
  try {
    embedding = await getEmbedding(content);
  } catch (err) {
    stats.errors++;
    console.error(`  Error embedding ${note.filename}: ${err}`);
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "error", reason: String(err), import_batch: args.importBatch, timestamp: new Date().toISOString() });
    return;
  }

  const result = await insertThought(content, embedding, fingerprint, note, metadata, attachments, mtime, args);
  stats.totalCost += estimateCost(wc);

  if (result.duplicate) {
    stats.duplicate++;
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "duplicate", import_batch: args.importBatch, timestamp: new Date().toISOString() });
  } else if (result.ok) {
    stats.ingested++;
    stats.movedToDone++;
    const verb = existingId ? "Updated" : "Ingested";
    console.log(`${note.relPath}`);
    console.log(`   -> ${verb}: ${metadata.type} — ${metadata.topics.join(", ")} (confidence: ${metadata.confidence.toFixed(2)})\n`);
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "ingested", reason: existingId ? "replaced" : undefined, import_batch: args.importBatch, timestamp: new Date().toISOString() });
    try {
      const destDir = `${DONE_DIR}${note.folder ? note.folder + "/" : ""}`;
      await Deno.mkdir(destDir, { recursive: true });
      await Deno.rename(note.absPath, `${destDir}${note.filename}`);
    } catch (err) {
      console.error(`  Warning: could not move ${note.filename} to mdDone: ${err}`);
    }
  } else {
    stats.errors++;
    console.error(`  Error ingesting ${note.filename}: ${result.error}`);
    await writeAuditEntry({ id: note.filename, date: mtime.slice(0, 10), title: note.title, status: "error", reason: result.error, import_batch: args.importBatch, timestamp: new Date().toISOString() });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args.dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_API_KEY)) {
    console.error("\nMissing environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY");
    Deno.exit(1);
  }

  let files = await discoverFiles(args.folder);

  if (args.sample > 0) {
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
    files = files.slice(0, args.sample);
  }

  if (args.limit > 0) files = files.slice(0, args.limit);

  const scope = args.folder ? `mdInbox/${args.folder}` : "mdInbox";
  console.log(`\nFound ${files.length} files in ${scope}.`);
  if (args.dryRun) console.log("Mode: DRY RUN — no files will be ingested or moved.");
  if (args.sample > 0) console.log(`Sample: ${files.length} random files selected.`);
  console.log();

  if (args.confirm && !args.dryRun) {
    await Deno.stdout.write(new TextEncoder().encode("Proceed? (Y/N): "));
    const buf = new Uint8Array(10);
    const n = await Deno.stdin.read(buf);
    const answer = new TextDecoder().decode(buf.slice(0, n ?? 0)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") { console.log("Aborted."); Deno.exit(0); }
    console.log();
  }

  if (!args.dryRun) {
    console.log(`  Import batch: ${args.importBatch}`);
    console.log(`  Concurrency : ${args.concurrency}\n`);
  }

  const stats: Stats = {
    filesFound: files.length,
    processed: 0, ingested: 0, duplicate: 0, noise: 0, errors: 0,
    movedToDone: 0, totalWords: 0, totalCost: 0, dryRunCounter: 0,
  };

  // Force sequential in dry-run to keep numbered output clean
  const concurrency = args.dryRun ? 1 : args.concurrency;
  const tasks = files.map(note => () => processNote(note, args, stats));
  await runWithConcurrency(tasks, concurrency);

  console.log("─".repeat(60));
  console.log("Summary:");
  console.log(`  Files found     : ${stats.filesFound}`);
  console.log(`  Already ingested: ${stats.duplicate} (skipped)`);
  console.log(`  Processed       : ${stats.processed}`);
  console.log(`  Skipped (noise) : ${stats.noise}`);
  console.log(`  Ingested        : ${stats.ingested}`);
  console.log(`  Errors          : ${stats.errors}`);
  console.log(`  Total words     : ${stats.totalWords.toLocaleString()}`);
  console.log(`  Est. API cost   : $${stats.totalCost.toFixed(4)}`);
  if (!args.dryRun) {
    console.log(`  Import batch    : ${args.importBatch}`);
    console.log(`  Audit log       : ${AUDIT_LOG_PATH}`);
    console.log(`  Moved to mdDone : ${stats.movedToDone}`);
  }
}

main().catch(err => { console.error("\nFatal error:", err.message); Deno.exit(1); });
