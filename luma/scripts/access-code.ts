/**
 * Prints the current access code. It lives encrypted in the vault, so reading
 * it needs the master key rather than a plain file — this is the supported way
 * to recover it without restarting the server.
 */
import { SECRET } from "../src/server/config.ts";
import { loadMasterKey, SecretVault } from "../src/server/crypto/secrets.ts";
import { paths } from "../src/server/env.ts";
import { Db } from "../src/server/store/db.ts";
import { Store } from "../src/server/store/store.ts";

const store = new Store(new Db(paths.db));
const vault = new SecretVault(store, loadMasterKey(paths.masterKey));
const code = vault.get(SECRET.accessCode);

console.log(code ?? "(no access code yet — start the server once to generate one)");
