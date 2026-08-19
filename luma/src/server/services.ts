import { Runtime } from "./agent/runtime.ts";
import { Sessions } from "./agent/sessions.ts";
import { Config } from "./config.ts";
import { loadMasterKey, SecretVault } from "./crypto/secrets.ts";
import { ensureDirectories, paths } from "./env.ts";
import { EventBus } from "./events/bus.ts";
import { Jobs } from "./generation/jobs.ts";
import { McpPool } from "./mcp/pool.ts";
import { ModelRegistry } from "./models/registry.ts";
import { Retrieval } from "./rag/retrieval.ts";
import { Db } from "./store/db.ts";
import { seed } from "./store/seed.ts";
import { Store } from "./store/store.ts";

export interface Services {
  db: Db;
  store: Store;
  sessions: Sessions;
  vault: SecretVault;
  config: Config;
  registry: ModelRegistry;
  retrieval: Retrieval;
  mcp: McpPool;
  bus: EventBus;
  jobs: Jobs;
  runtime: Runtime;
  /** Rebuilds provider/model state after any settings write. */
  reload(): void;
  close(): Promise<void>;
}

export function createServices(
  options: { dbFile?: string; masterKeyFile?: string; sessionsFile?: string } = {},
): Services {
  ensureDirectories();
  const db = new Db(options.dbFile ?? paths.db);
  const store = new Store(db);
  const vault = new SecretVault(store, loadMasterKey(options.masterKeyFile ?? paths.masterKey));
  const config = new Config(store, vault);
  seed(store, config, vault);
  store.failStaleRuns();
  // Ordered after failStaleRuns, which is what makes those runs non-active and
  // so makes their unanswered approval requests recognisably orphaned.
  store.expireOrphanApprovals();
  store.purgeExpiredSessions();
  // Nothing can be mid-stream across a restart, so stale deltas are dead weight.
  store.pruneSettledTransientEvents(0);
  // Converting an older database rewrites the whole file, so it happens once
  // the server is already answering requests rather than in front of startup.
  setTimeout(() => {
    try {
      const freed = store.reclaimStorage();
      if (freed) console.log(`[store] reclaimed ${freed} free pages`);
    } catch (error) {
      console.warn(`[store] reclaim skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 5_000).unref();

  const registry = new ModelRegistry(store, vault);
  const retrieval = new Retrieval(store, config, vault);
  const mcp = new McpPool(store, vault, config);
  const bus = new EventBus();
  const sessions = new Sessions(options.sessionsFile ?? paths.sessionsDb);
  const jobs = new Jobs(store, vault);
  const runtime = new Runtime(store, config, vault, registry, retrieval, mcp, bus, sessions, jobs);
  // A render the backend still owns is rejoined rather than paid for twice
  // (07-generation.md §Jobs).
  const recovered = jobs.recover();
  if (recovered.rejoined || recovered.requeued || recovered.failed) {
    console.log(
      `[jobs] recovered: ${recovered.rejoined} rejoined, ${recovered.requeued} requeued, ${recovered.failed} failed`,
    );
  }

  return {
    db,
    store,
    sessions,
    vault,
    config,
    registry,
    retrieval,
    mcp,
    bus,
    jobs,
    runtime,
    reload: () => registry.reload(),
    close: async () => {
      await jobs.close();
      await mcp.close();
      await sessions.close();
      db.close();
    },
  };
}
