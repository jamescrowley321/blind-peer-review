// Compose the prompt a lens agent receives: persona + shared contract + diff.
//
// Extracted from action.yml's inline `run:` block (shell: node {0}). Same split
// as scripts/models-config.mjs: the logic is a file that can be read, diffed and
// tested as code, and action.yml runs it in one line.
//
// Reads its inputs from `env` rather than process.env so a test supplies them
// directly. The CLI entrypoint at the bottom is what the action invokes.

function run({ env }) {
  const fs = require("fs");
  const path = require("path");
  // Throws rather than calling process.exit: the action's CLI entrypoint turns
  // this into the same ::error:: line and exit 1 it always produced, while a
  // test that drives the module in-process gets an exception instead of having
  // its own runner killed mid-suite.
  const die = (m) => { console.log(`::error::${m}`); throw new Error(m); };

  const actionPath = env.ACTION_PATH;
  const lensKey = env.LENS_KEY;
  // The key becomes a file path, so it is checked against the registry before
  // it is joined to one. `lens: ../action.yml` would otherwise load an
  // arbitrary file out of the action directory as the persona — swapping the
  // reviewer for something that is not a reviewer. Workflow inputs are
  // author-controlled, not PR-controlled, so this is defence in depth rather
  // than a boundary; it costs one read and removes the class.
  const registry = path.join(actionPath, "lenses", "manifest.json");
  let known;
  try {
    known = JSON.parse(fs.readFileSync(registry, "utf8")).lenses.map((l) => l.key);
  } catch (e) {
    // The registry ships with the action, so this means a corrupt checkout
    // rather than a caller mistake — but an unhandled parse throw buries that
    // under a stack trace in a log nobody reads to the end.
    die(`Could not read the lens registry at ${registry}: ${e.message}`);
  }
  if (!/^[a-z0-9_]+$/.test(lensKey) || !known.includes(lensKey)) {
    die(`Unknown lens "${lensKey}". Known lenses: ${known.join(", ")}.`);
  }
  const personaPath = path.join(actionPath, "lenses", `${lensKey}.md`);
  const sharedPath = path.join(actionPath, "lenses", "shared_instructions.md");
  if (!fs.existsSync(personaPath)) die(`Missing persona file ${personaPath}`);
  if (!fs.existsSync(sharedPath)) die("Missing shared_instructions.md");

  // Hand the agent the exact repo + PR from trusted GitHub Actions context
  // (never from PR content), so get_pr_diff / get_issue_or_pr_thread resolve
  // without guessing. The read+review-only tool allowlist otherwise leaves
  // the agent no way to self-discover owner/repo, and it fails the diff fetch.
  const repo = (env.REPO || "").trim();          // "owner/name"
  const [owner, name] = repo.split("/");
  // Temporal grounding: a model whose training cutoff predates the run date
  // otherwise flags legitimate current-year timestamps (commit/PR/copyright
  // dates) as "future" / "fabricated" / an integrity problem — a false
  // positive that fails the Merge Gate on healthy PRs (seen with Gemini 2.5
  // Pro on 2026 dates).
  //
  // Prefer a GitHub-stamped timestamp from the event payload over the
  // runner's own clock: the payload is written by GitHub, while the runner
  // clock is merely whatever the machine reports. Neither is reachable from
  // PR content — which is the property that actually matters here, since a
  // date the PR author could set would let a PR silently disable this
  // grounding — but the payload is the better of the two. Fall back to the
  // runner clock only if the payload is unreadable or carries no timestamp.
  const isoDay = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  let today = null;
  try {
    const ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    today =
      isoDay(ev?.pull_request?.updated_at) ||
      isoDay(ev?.repository?.pushed_at) ||
      isoDay(ev?.repository?.updated_at);
  } catch (_) { /* fall through to the runner clock */ }
  if (!today) today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
  const target =
    `You are reviewing GitHub pull request #${env.PR} in repository ` +
    `\`${repo}\`. When you call \`get_pr_diff\` or \`get_issue_or_pr_thread\`, pass ` +
    `exactly owner=\`${owner}\`, repo=\`${name}\`, pull_number=${env.PR}. ` +
    `Do not guess or try other owner/repo values.\n\n` +
    `Temporal grounding: today's date is ${today} (UTC) — this is authoritative, ` +
    `from CI, and may be later than your training cutoff. Dates on or before it ` +
    `are past or present; do NOT flag recent or current-year timestamps (commit, ` +
    `PR, changelog, or copyright dates) as "future", "post-dated", "fabricated", ` +
    `or an integrity issue — they are expected. Only a date AFTER ${today}, or one ` +
    `internally inconsistent with others in the diff, is worth noting.\n\n`;

  const personaText = fs.readFileSync(personaPath, "utf8");
  // Tell the agent what it will NOT be shown. get_pr_diff silently drops
  // every path matching diff_ignore_patterns, so a filtered diff is
  // indistinguishable from a complete one and the agent reports the
  // withheld files as missing. Observed on #34: 50 of 53 changed files
  // were under an ignored path, and four lenses blocked the PR claiming
  // the work was absent. Naming the exclusions converts a false "it is
  // missing" into a correct "I was not shown it".
  // Inputs are workflow-author controlled, but a caller can wire one to a
  // templated expression fed by PR content, so nothing goes into the
  // prompt unvalidated. Patterns are whitespace-split (so no token carries
  // a newline) and then bounded in size and count; anything odd is dropped
  // rather than rendered.
  const ignored = (env.IGNORED_PATHS || "")
    .trim()
    .split(/\s+/)
    .filter((t) => t && t.length <= 200 && !/[`\r\n]/.test(t))
    .slice(0, 50);
  const scope = ignored.length
    ? `Diff scope: paths matching ${ignored.map((p) => `\`${p}\``).join(", ")} are ` +
      `withheld from the diff you fetch. Files under them are NOT part of your ` +
      `evidence and their absence is not a finding. If the code a requirement ` +
      `concerns would live under a withheld path, you have verified nothing about ` +
      `it — say so and lower the severity accordingly. Never report a withheld ` +
      `file as missing, unimplemented, or absent.\n\n`
    : "";

  // Same failure as the withheld paths above, in its more dangerous form:
  // get_pr_diff truncates at these limits and the agent cannot tell a
  // truncated diff from a complete one. Every incident where a lens
  // reported present code as "entirely absent" is consistent with this —
  // the worst of them was a 5,855-insertion PR against a 2,000-line cap.
  // Naming the limits lets the agent recognise the boundary and say its
  // evidence ran out instead of concluding the work was never done.
  // These two are integers. Validate rather than pass through: a caller
  // that derives them from PR content would otherwise splice attacker text
  // straight into the prompt. A non-integer is dropped.
  const asCount = (v) => {
    const t = String(v ?? "").trim();
    return /^[0-9]{1,12}$/.test(t) && Number(t) > 0 ? String(Number(t)) : "";
  };

  // These must mirror the `default:` of diff_max_lines / diff_max_bytes.
  // Pinned by a contract test that reads the defaults back out of this
  // file, so the two cannot drift apart silently.
  const DEFAULT_MAX_LINES = "2000";
  const DEFAULT_MAX_BYTES = "204800";

  // A byte cap below this is refused rather than passed on. Two reasons.
  //
  // The engine's byte truncation computes `budget = maxBytes - markerLen`
  // where the marker is "\n... (truncated at N bytes)" (26 + digits). It
  // does not floor that at zero, so a cap under ~30 makes `budget`
  // negative, `buf.subarray(0, budget)` takes its from-the-end meaning,
  // and the tool returns MORE than the cap asked for — the opposite of
  // the contract. (Reported upstream; see docs/upstream-issues.md.)
  //
  // And a cap under 1 KiB cannot hold a single hunk, so any value here is
  // a misconfiguration whatever the engine does with it.
  const MIN_MAX_BYTES = 1024;

  // Validate what we PASS, not just what we say. The prompt names these
  // caps as fact; an unvalidated value would be forwarded to the diff
  // tool, silently replaced by ITS default, and the sentence the lens
  // read would be false. A lens taught to distrust the disclosure is
  // worse off than one never given it.
  // Empty stays empty: a caller who explicitly clears a cap is opting out
  // of the disclosure, and this step has never invented one for them.
  // Only a value that was SUPPLIED and cannot be honoured is replaced.
  const resolve = (raw, fallback, name, floor) => {
    const given = String(raw ?? "").trim();
    if (given === "") return "";
    const ok = asCount(given);
    if (!ok) {
      // "0" reads as "unlimited" to plenty of people. It is not: there is
      // no uncapped mode, and forwarding 0 would truncate to nothing.
      // Say so rather than let the generic message imply a typo.
      const zero = /^0+$/.test(given)
        ? ` There is no uncapped mode — clear ${name} to defer to the diff tool's own limit.`
        : "";
      console.log(`::warning::${name} is not a positive integer; using ${fallback} instead so the prompt and the diff tool agree.${zero}`);
      return fallback;
    }
    if (floor && Number(ok) < floor) {
      console.log(`::warning::${name} ${ok} is below the ${floor}-byte floor — the diff tool's byte budget goes negative under ~30 bytes and it returns MORE than the cap promises, and no hunk fits under 1 KiB. Using ${fallback}.`);
      return fallback;
    }
    return ok;
  };
  const effLines = resolve(env.MAX_LINES, DEFAULT_MAX_LINES, "diff_max_lines", 0);
  const effBytes = resolve(env.MAX_BYTES, DEFAULT_MAX_BYTES, "diff_max_bytes", MIN_MAX_BYTES);
  fs.appendFileSync(env.GITHUB_ENV, `EFFECTIVE_MAX_LINES=${effLines}\nEFFECTIVE_MAX_BYTES=${effBytes}\n`);

  const maxLines = effLines;
  const maxBytes = effBytes;
  const limits = (maxLines || maxBytes)
    ? `Diff limits: the diff you fetch is truncated at ` +
      [maxLines && `${maxLines} lines`, maxBytes && `${maxBytes} bytes`].filter(Boolean).join(" and ") +
      `. A large pull request WILL be cut off. If the diff ends abruptly, or a ` +
      `file you expected is absent, or a hunk stops mid-change, assume you are ` +
      `looking at a truncated diff and NOT at a complete change. Absence of code ` +
      `in a truncated diff is not evidence that the code is missing — say your ` +
      `evidence was incomplete, name what you could not see, and do not raise a ` +
      `blocking finding on it.\n\n`
    : "";

  let prompt = target + scope + limits + personaText.split("__PR_NUMBER__").join(env.PR) + "\n";

  // Publish the persona's H1 for the parse step. Models routinely echo the
  // heading, or just its subtitle, instead of the primary lens name — that
  // is what killed every Security Review job when the heading read "Security Review —
  // Security Auditor Agent" and the model emitted "Security Auditor".
  // Deriving the accepted names from the shipped heading fixes the whole
  // class; a hand-maintained alias map only ever covers the strings someone
  // already got paged for.
  const headingLine = personaText.split("\n").find((l) => l.startsWith("# "));
  const heading = headingLine ? headingLine.replace(/^#\s*/, "").trim() : "";
  fs.appendFileSync(env.GITHUB_ENV, `LENS_HEADING<<ADV_LENS_HEADING_EOF\n${heading}\nADV_LENS_HEADING_EOF\n`);

  // The reviewer's instructions come ONLY from this action's own pinned,
  // trusted lenses — never from the PR-under-review's checkout. Reading a
  // persona or rules file out of the untrusted PR head would let a PR
  // rewrite its own reviewer ("post No findings, approve") — prompt
  // injection, OWASP LLM01. Per-repo tuning is a LOCAL, trusted feature
  // (see lenses/README.md); CI always runs the static base set.
  prompt += "\n" + fs.readFileSync(sharedPath, "utf8");

  const delim = "ADV_REVIEW_PROMPT_EOF";
  fs.appendFileSync(env.GITHUB_ENV, `COMPOSED_PROMPT<<${delim}\n${prompt}\n${delim}\n`);

  // Publish the tool allowlist the pi step will actually use.
  //
  // `submit_findings` has to be NAMED in loaded_tools or the allowlist
  // excludes it and the whole point is lost — but naming a tool that was
  // never registered fails the run early, so it may only be appended when
  // the extension is actually being loaded. Computed here rather than
  // baked into the input default, because a consumer who narrows
  // loaded_tools would otherwise silently lose the channel.
  //
  // `all` is passed through untouched: it is a sentinel, not a list, and
  // appending to it produces a name no tool has.
  const toolsIn = String(env.LOADED_TOOLS ?? "").trim();
  const wantTool = String(env.SUBMIT_TOOL ?? "true").trim().toLowerCase() === "true";
  let effectiveTools = toolsIn;
  if (wantTool && toolsIn !== "all") {
    const names = toolsIn.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!names.includes("submit_findings")) names.push("submit_findings");
    effectiveTools = names.join("\n");
  }
  fs.appendFileSync(
    env.GITHUB_ENV,
    `EFFECTIVE_LOADED_TOOLS<<ADV_TOOLS_EOF\n${effectiveTools}\nADV_TOOLS_EOF\n`,
  );
}

module.exports = { run };

if (require.main === module) {
  try {
    run({ env: process.env });
  } catch {
    // die() has already emitted the ::error:: annotation; exit is the only part
    // a module cannot do on a caller's behalf.
    process.exit(1);
  }
}
