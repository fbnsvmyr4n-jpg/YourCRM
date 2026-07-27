import { promises as fs } from "fs";
import path from "path";
import { dbMutate, dbRead, dbWrite, usingPostgres } from "./db";

/**
 * The storage seam for the whole app.
 *
 * Every repository reads and writes through `readTable` / `writeTable`, so the
 * engine underneath can change without touching app code:
 *
 *   • `DATABASE_URL` set  → Postgres (required in production — serverless hosts
 *                           have no persistent filesystem)
 *   • otherwise           → JSON files under `.data/` (zero-setup local dev)
 */

const DATA_DIR = path.join(process.cwd(), ".data");

/**
 * The file store is dev-only. On a serverless host the filesystem is ephemeral
 * and per-instance, so writes appear to succeed and then vanish — silent data
 * loss that looks exactly like a working app until a user notices their records
 * are gone. Refuse to serve rather than pretend to persist.
 */
function assertFileStoreAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not set, so the app fell back to the local file store. " +
        "That store does not persist on serverless hosts — data written would be silently lost. " +
        "Set DATABASE_URL to a Postgres connection string (e.g. a pooled Neon URL)."
    );
  }
}

async function ensureDir() {
  assertFileStoreAllowed();
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function fileFor(name: string) {
  return path.join(DATA_DIR, `${name}.json`);
}

async function fileRead<T>(name: string, seed: T[]): Promise<T[]> {
  await ensureDir();
  const file = fileFor(name);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T[];
  } catch {
    await fs.writeFile(file, JSON.stringify(seed, null, 2), "utf8");
    return seed;
  }
}

/** Overwrite a file table (atomic-ish via temp file rename). */
async function fileWrite<T>(name: string, rows: T[]): Promise<void> {
  await ensureDir();
  const file = fileFor(name);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Serialises file-store mutations per table within this process, so a
 * read-modify-write can't be interleaved by a concurrent request.
 */
const fileLocks = new Map<string, Promise<unknown>>();

async function fileMutate<T>(
  name: string,
  seed: T[],
  mutate: (rows: T[]) => T[] | Promise<T[]>
): Promise<T[]> {
  const previous = fileLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(
    name,
    previous.then(() => held)
  );

  await previous.catch(() => {}); // a failed predecessor must not block the queue
  try {
    const next = await mutate(await fileRead(name, seed));
    await fileWrite(name, next);
    return next;
  } finally {
    release();
  }
}

/** Read a table, seeding it from `seed` on first access. */
export async function readTable<T>(name: string, seed: T[]): Promise<T[]> {
  return usingPostgres() ? dbRead(name, seed) : fileRead(name, seed);
}

/**
 * Read, transform and write a table as one atomic unit.
 *
 * **Use this for every write that depends on current contents** (create,
 * update, delete). A bare `readTable` + `writeTable` pair loses data when two
 * requests overlap — the second overwrites the first.
 */
export async function mutateTable<T>(
  name: string,
  seed: T[],
  mutate: (rows: T[]) => T[] | Promise<T[]>
): Promise<T[]> {
  return usingPostgres() ? dbMutate(name, seed, mutate) : fileMutate(name, seed, mutate);
}

/** Replace a table's contents. */
export async function writeTable<T>(name: string, rows: T[]): Promise<void> {
  return usingPostgres() ? dbWrite(name, rows) : fileWrite(name, rows);
}

/** Which engine is active — surfaced in Settings so it's visible before deploy. */
export function storageEngine(): "postgres" | "file" {
  return usingPostgres() ? "postgres" : "file";
}
