import type { Env } from "../env.js";
import type { ConnectionResolver } from "../engine/ports.js";

/**
 * The credential vault.
 *
 * Envelope encryption, because Workers Secrets Store is account-scoped and this
 * is a multi-tenant platform:
 *
 *   root KEK (Secrets Store)
 *     └── wraps a per-tenant DEK (stored wrapped in D1)
 *           └── encrypts each connection payload (stored as ciphertext in D1)
 *
 * Plaintext exists only in the run Worker's memory, for the duration of the
 * step that needs it. Nothing decrypted is ever written back, logged, or
 * returned by the API — which is the invariant the CLI's backend mode already
 * states: "values never persist on either side".
 */

const AES = "AES-GCM";
const IV_BYTES = 12;

async function importKek(env: Env): Promise<CryptoKey> {
  const material = env.CREDENTIAL_KEK;
  if (!material) {
    throw new Error(
      "CREDENTIAL_KEK is not configured; connections cannot be read or written",
    );
  }
  // The KEK is stored base64; it must be a 256-bit key.
  const raw = Uint8Array.from(atob(material), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("CREDENTIAL_KEK must be a base64-encoded 256-bit key");
  }
  return crypto.subtle.importKey("raw", raw, AES, false, ["encrypt", "decrypt"]);
}

async function unwrapDek(env: Env, wrapped: ArrayBuffer, iv: ArrayBuffer): Promise<CryptoKey> {
  const kek = await importKek(env);
  const raw = await crypto.subtle.decrypt({ name: AES, iv: new Uint8Array(iv) }, kek, wrapped);
  return crypto.subtle.importKey("raw", raw, AES, false, ["encrypt", "decrypt"]);
}

/** Creates a tenant DEK, wraps it under the KEK, and stores the wrapped form. */
export async function createTenantKey(env: Env, tenantId: string): Promise<void> {
  const kek = await importKek(env);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.encrypt({ name: AES, iv }, kek, dek);

  await env.DB.prepare(
    `INSERT INTO tenant_keys (tenant_id, key_version, wrapped_dek, wrap_iv, created_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT (tenant_id, key_version) DO NOTHING`,
  )
    .bind(tenantId, wrapped, iv.buffer, Date.now())
    .run();
}

async function tenantKey(env: Env, tenantId: string, version: number): Promise<CryptoKey> {
  const row = await env.DB.prepare(
    `SELECT wrapped_dek, wrap_iv FROM tenant_keys WHERE tenant_id = ? AND key_version = ?`,
  )
    .bind(tenantId, version)
    .first<{ wrapped_dek: ArrayBuffer; wrap_iv: ArrayBuffer }>();

  if (!row) throw new Error(`tenant ${tenantId} has no key version ${version}`);
  return unwrapDek(env, row.wrapped_dek, row.wrap_iv);
}

export async function putConnection(
  env: Env,
  tenantId: string,
  input: { id: string; name: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  const key = await tenantKey(env, tenantId, 1);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: AES, iv },
    key,
    new TextEncoder().encode(JSON.stringify(input.payload)),
  );

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO connections (id, tenant_id, name, type, secret_cipher, secret_iv, key_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       type = excluded.type,
       secret_cipher = excluded.secret_cipher,
       secret_iv = excluded.secret_iv,
       key_version = excluded.key_version,
       updated_at = excluded.updated_at`,
  )
    .bind(input.id, tenantId, input.name, input.type, cipher, iv.buffer, now, now)
    .run();
}

export interface ConnectionRecord {
  name: string;
  type: string;
  payload: Record<string, unknown>;
}

async function readConnection(
  env: Env,
  tenantId: string,
  name: string,
): Promise<ConnectionRecord | null> {
  const row = await env.DB.prepare(
    `SELECT name, type, secret_cipher, secret_iv, key_version
       FROM connections WHERE tenant_id = ? AND name = ?`,
  )
    .bind(tenantId, name)
    .first<{
      name: string;
      type: string;
      secret_cipher: ArrayBuffer;
      secret_iv: ArrayBuffer;
      key_version: number;
    }>();

  if (!row) return null;

  const key = await tenantKey(env, tenantId, row.key_version);
  const plain = await crypto.subtle.decrypt(
    { name: AES, iv: new Uint8Array(row.secret_iv) },
    key,
    row.secret_cipher,
  );
  return {
    name: row.name,
    type: row.type,
    payload: JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>,
  };
}

/**
 * A resolver bound to one tenant and one run.
 *
 * Two guarantees carry over from `engine.ResolveCredential` in the CLI:
 * a connection the run was not granted is an error rather than a fallback to
 * any other source, and the connection's declared type must match what the
 * action expects, so a Slack token cannot be handed to an OpenAI step.
 */
export function connectionResolver(
  env: Env,
  tenantId: string,
  expectedTypes: Map<string, string>,
): ConnectionResolver {
  const cache = new Map<string, Record<string, unknown>>();

  return {
    async resolve(name: string): Promise<Record<string, unknown>> {
      const cached = cache.get(name);
      if (cached) return cached;

      const record = await readConnection(env, tenantId, name);
      if (!record) {
        throw new Error(`connection ${JSON.stringify(name)} was not provided to this run`);
      }

      const expected = expectedTypes.get(name);
      if (expected && record.type !== expected) {
        throw new Error(
          `connection ${JSON.stringify(name)} type mismatch: got ${record.type}, want ${expected}`,
        );
      }

      cache.set(name, record.payload);
      return record.payload;
    },
  };
}
