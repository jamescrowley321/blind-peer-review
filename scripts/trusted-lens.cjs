// CI overrides come only from the target PR's immutable base commit, never
// from its checkout, head, a configurable ref, or a PR-supplied path.
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 15000;

function validatePersona(data, expectedPath) {
  if (!data || Array.isArray(data) || data.type !== "file" || data.path !== expectedPath ||
      data.encoding !== "base64" || !Number.isInteger(data.size) || data.size <= 0 || data.size > MAX_BYTES ||
      typeof data.content !== "string" || data.content.length > Math.ceil(MAX_BYTES / 3) * 4 + 2048) {
    throw new Error("Trusted lens override must be a regular, nonempty UTF-8 Markdown file of at most 64 KiB, returned as base64 at the requested path.");
  }
  const encoded = data.content.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Trusted lens override has malformed base64 encoding.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== data.size || bytes.toString("base64") !== encoded) {
    throw new Error("Trusted lens override size or base64 encoding does not match its content.");
  }
  let persona;
  try { persona = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Trusted lens override is not valid UTF-8."); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(persona) ||
      !/^# [^\r\n]{1,200}$/.test(persona.trim().split(/\r?\n/)[0])) {
    throw new Error("Trusted lens override must begin with a Markdown H1 (at most 200 characters) and contain no control characters.");
  }
  return persona;
}

async function loadTrustedLens({ github, context, env }) {
  const enabled = String(env.TRUSTED_LENS_OVERRIDES ?? "false").trim();
  if (enabled === "false") return { persona: "", source: "pinned" };
  if (enabled !== "true") throw new Error("trusted_lens_overrides must be exactly true or false.");
  const key = env.LENS_KEY;
  const registry = require("node:fs").readFileSync(require("node:path").join(env.ACTION_PATH, "lenses/manifest.json"), "utf8");
  const known = JSON.parse(registry).lenses.map((lens) => lens.key);
  if (!/^[a-z0-9_]+$/.test(key) || !known.includes(key)) throw new Error("Unknown trusted lens override key.");
  const rawPr = String(env.PR_NUMBER ?? "").trim();
  const pull_number = Number(rawPr);
  if (!/^[1-9][0-9]*$/.test(rawPr) || !Number.isSafeInteger(pull_number)) throw new Error("Trusted lens overrides require a positive PR_NUMBER.");
  const { owner, repo } = context.repo;
  const request = { timeout: TIMEOUT_MS };
  let pr;
  try { ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number, request })); }
  catch (e) { throw apiError("resolve the target PR base commit", e); }
  const sha = pr?.base?.sha;
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "") ||
      pr?.base?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("Target PR returned an invalid base SHA or a base repository different from the workflow repository.");
  }
  const overridePath = `.blind-peer-review/lenses/${key}.md`;
  let commit;
  try {
    ({ data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: sha, request }));
  } catch (e) { throw apiError("read the exact PR base commit", e); }
  let treeSha = commit?.commit?.tree?.sha;
  if (commit?.sha !== sha || !/^[a-f0-9]{40}$/i.test(treeSha ?? "")) throw new Error("Could not verify the exact PR base commit and its tree.");
  // Walk only three nonrecursive trees. Unlike the contents endpoint this
  // cannot silently follow a symlink to some other file. A real missing entry
  // in a successfully fetched complete tree is the ONLY fallback condition;
  // GitHub's auth-hiding 404 errors never become 'no override'.
  const parts = overridePath.split("/");
  for (let i = 0; i < parts.length; i++) {
    let tree;
    try { ({ data: tree } = await github.rest.git.getTree({ owner, repo, tree_sha: treeSha, request })); }
    catch (e) { throw apiError("read the trusted override tree", e); }
    if (!tree || tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 4096 ||
        tree.tree.some((entry) => !entry || typeof entry.path !== "string" || entry.path.includes("/"))) {
      throw new Error("Trusted override tree is malformed, truncated, or exceeds 4096 entries.");
    }
    const matches = tree.tree.filter((entry) => entry.path === parts[i]);
    if (!matches.length) return { persona: "", source: "pinned (override absent)", baseSha: sha };
    const entry = matches[0];
    if (matches.length !== 1 || !/^[a-f0-9]{40}$/i.test(entry.sha ?? "")) throw new Error("Trusted override path has malformed tree metadata.");
    if (i < parts.length - 1) {
      if (entry.type !== "tree" || entry.mode !== "040000") throw new Error("Trusted override parent must be a regular directory, never a symlink or submodule.");
      treeSha = entry.sha;
      continue;
    }
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) ||
        !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > MAX_BYTES) {
      throw new Error("Trusted override must be a regular, nonempty file of at most 64 KiB, never a symlink or submodule.");
    }
    let blob;
    try { ({ data: blob } = await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha, request })); }
    catch (e) { throw apiError("read the trusted lens override blob", e); }
    if (blob?.sha !== entry.sha || blob?.size !== entry.size) throw new Error("Trusted override blob metadata does not match its base tree.");
    const persona = validatePersona({ ...blob, type: "file", path: overridePath }, overridePath);
    return { persona, source: `${overridePath}@${sha}`, baseSha: sha };
  }
}

function apiError(operation, error) {
  // Never echo the raw request/error; third-party error messages can include
  // headers or credentials. Status and the failed operation suffice to diagnose.
  const status = Number.isInteger(error?.status) ? `HTTP ${error.status}` : "network/timeout error";
  return new Error(`Could not ${operation}: ${status}. trusted_lens_overrides requires contents: read and access to the target PR.`);
}

async function run({ core, github, context, env }) {
  const result = await loadTrustedLens({ github, context, env });
  // core uses a random multiline delimiter, so persona text cannot inject
  // another Actions environment variable. Clear these even when opt-in is off.
  core.exportVariable("TRUSTED_LENS_PERSONA", result.persona);
  core.exportVariable("TRUSTED_LENS_SOURCE", result.source);
  core.info(`Lens persona source: ${result.source}`);
  return result;
}

module.exports = { run, loadTrustedLens, validatePersona, MAX_BYTES };
