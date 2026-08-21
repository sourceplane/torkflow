import type { Env } from "../env.js";
import type { BundleReader } from "../expression/resolve.js";
import { sha256Hex } from "./ids.js";

/**
 * Workflow bundles.
 *
 * A bundle is the workflow YAML plus every file it references — `fromFile`
 * prompts, `scriptFile` scripts. It is content-addressed by the SHA-256 of its
 * manifest, and a run pins that digest, so the exact definition a run executed
 * can always be re-read even after the workflow has been edited a dozen times.
 */

export interface BundleFile {
  path: string;
  content: string;
}

export interface Bundle {
  digest: string;
  workflowPath: string;
  files: BundleFile[];
}

/** Normalises a bundle-relative path and refuses anything that escapes it. */
export function normalizeBundlePath(path: string): string {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new Error(`bundle path ${JSON.stringify(path)} must be relative to the bundle root`);
  }

  const segments: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Refuse rather than pop: a path that tries to climb out is a bug or an
      // attack, and silently clamping it would hide both. The CLI's
      // `resolveFromFile` joins and cleans, which lets `../../etc/passwd`
      // escape the workflow directory — on a shared runner that is arbitrary
      // file read across tenants.
      throw new Error(`bundle path ${JSON.stringify(path)} escapes the bundle root`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) throw new Error("bundle path cannot be empty");
  return segments.join("/");
}

export async function computeDigest(files: BundleFile[]): Promise<string> {
  // Sorted, so the digest depends on content alone and not on upload order.
  const manifest = [...files]
    .map((file) => [normalizeBundlePath(file.path), file.content])
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
  return sha256Hex(JSON.stringify(manifest));
}

export async function putBundle(env: Env, files: BundleFile[]): Promise<string> {
  const digest = await computeDigest(files);
  for (const file of files) {
    const path = normalizeBundlePath(file.path);
    await env.BUNDLES.put(`${digest}/${path}`, file.content, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  await env.BUNDLES.put(
    `${digest}/.manifest.json`,
    JSON.stringify({ digest, paths: files.map((f) => normalizeBundlePath(f.path)).sort() }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return digest;
}

/** Reads files out of a published bundle, confined to that bundle's prefix. */
export function bundleReader(env: Env, digest: string): BundleReader {
  const cache = new Map<string, string>();

  return {
    async read(path: string): Promise<string> {
      const normalized = normalizeBundlePath(path);
      const cached = cache.get(normalized);
      if (cached !== undefined) return cached;

      const object = await env.BUNDLES.get(`${digest}/${normalized}`);
      if (!object) {
        throw new Error(`bundle ${digest.slice(0, 12)} has no file ${JSON.stringify(normalized)}`);
      }
      const content = await object.text();
      cache.set(normalized, content);
      return content;
    },
  };
}

/** An in-memory bundle, for tests and for single-file workflows. */
export function inMemoryBundle(files: Record<string, string>): BundleReader {
  return {
    async read(path: string): Promise<string> {
      const normalized = normalizeBundlePath(path);
      const content = files[normalized];
      if (content === undefined) throw new Error(`bundle has no file ${JSON.stringify(normalized)}`);
      return content;
    },
  };
}
