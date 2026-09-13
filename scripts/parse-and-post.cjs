// Parse the lens agent's findings and post the review.
//
// Extracted from action.yml's inline `script:` block — the largest of the five,
// and the last. The action calls it in two lines.
//
// This one carries a constraint the others did not. evals/verify-guards.mjs
// proves each regression guard is load-bearing by replaying HISTORICAL
// action.yml revisions through this step and asserting the guard TRIPS on the
// code that shipped the incident. A commit from before this refactor has no
// module to import, so a harness that only ever imported would silently ignore
// the historical source, test HEAD against HEAD, and report PASS — a guard that
// says it is guarding while guarding nothing. runParseStep therefore keeps the
// string-lift path for the `yml` argument and uses this module otherwise.

async function run({ core, github, context, env }) {
  const fs = require("fs");
  const lensName = env.LENS_NAME;
  const prNumber = Number(env.PR_NUMBER);
  const headSha = context.payload.pull_request.head.sha;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const SEVERITIES = new Set(["MUST FIX", "SHOULD FIX", "NITPICK"]);

  // ── 1. Read the review. ──
  // Preferred channel: the file submit_findings wrote. Its contents came
  // from a tool call whose arguments the PROVIDER checked against the
  // schema, so this path cannot carry prose, a stray fence, or a bad
  // escape — the three ways the message channel has failed in the field.
  // Absent or unreadable, fall through to the message and the tolerant
  // parser below; the tool is optional and can be switched off.
  const findingsPath = env.FINDINGS_PATH || "";
  let submitted = null;
  if (findingsPath) {
    try {
      if (fs.existsSync(findingsPath)) {
        submitted = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
      }
    } catch (e) {
      // Never fatal: the message channel is still there to try.
      core.warning(`submit_findings wrote a file this step could not read (${e.message}); falling back to the agent's final message.`);
      submitted = null;
    }
  }
  if (submitted) core.info(`Read the review from submit_findings (${findingsPath}).`);

  // ── 1b. Otherwise, extract the JSON object from the agent's final message. ──
  // The instructions ask for JSON only, but be tolerant: models often emit
  // a short prose preamble ("I'll fetch the diff.") before the JSON, or
  // wrap it in ```json fences. Strategy: strip fences, then walk brace
  // depth from the FIRST `{` to its MATCHING `}` (a lastIndexOf approach
  // breaks on nested objects like findings:[{...}], pointing at an inner
  // brace). Try the whole message first as the fast path.
  const raw = env.AGENT_RESPONSE || "";
  const fail = (m) => { core.setFailed(`Lens "${lensName}" — ${m}`); return null; };
  let parsed = submitted && typeof submitted === "object" ? submitted : null;
  // An empty final message is normal once the tool channel is in use:
  // the lens has said everything it has to say by calling the tool, and
  // some models reply with nothing afterwards. Only treat it as "the
  // agent produced no output" when there is no submitted review either.
  if (!parsed && !raw.trim()) {
    return fail(`agent produced no output (steps.pi.outputs.response empty; agent_success=${env.AGENT_SUCCESS}). Re-run this job to retry.`);
  }
  // Strip ```json / ``` fences so a fenced block parses as the whole.
  const fenceStripped = parsed ? "" : raw.replace(/```(?:json)?/gi, "").trim();
  if (!parsed) { try { parsed = JSON.parse(fenceStripped); } catch (_) {} }
  if (!parsed) {
    // Walk from the first `{` to its matching `}`, skipping braces inside
    // string literals (so `{` inside a JSON string value doesn't fool us).
    const start = fenceStripped.indexOf("{");
    if (start !== -1) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < fenceStripped.length; i++) {
        const c = fenceStripped[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) {
        try { parsed = JSON.parse(fenceStripped.slice(start, end + 1)); } catch (e) {
          return fail(`agent response was not valid JSON (${e.message}). Re-run this job to retry.`);
        }
      }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return fail("agent response had no parseable JSON object. Re-run this job to retry.");
  }

  // ── 2. Validate the schema. ──
  // Lens name: accept case-insensitive match OR one containing the other,
  // so a persona that calls itself "Policy & Provenance" validates against
  // a lens keyed "policy" (display "Compliance"). Exact match is the
  // common case; the fuzzy check is defensive against persona naming drift.
  const emittedLens = String(parsed.lens || "").trim();
  const norm = (s) => s.toLowerCase();
  // Accept documented persona subtitles as explicit aliases: some models emit
  // the subtitle despite being instructed to emit the primary name. This is
  // what killed every Security Review job when its heading still read
  // "Sentinel — Security Auditor Agent" and models answered "Security Auditor".
  const aliases = {
    "cold read — zero-context adversarial agent": "cold read",
    "edge cases — exhaustive path analysis agent": "edge cases",
    "acceptance criteria — spec conformance agent": "acceptance criteria",
    "security review — exploitable vulnerability agent": "security review",
    "red team — offensive attack-chain agent": "red team",
    "policy & provenance — contribution governance agent": "policy & provenance",
    "zero-context adversarial agent": "cold read",
    "exhaustive path analysis agent": "edge cases",
    "spec conformance agent": "acceptance criteria",
    "exploitable vulnerability agent": "security review",
    "offensive attack-chain agent": "red team",
    "contribution governance agent": "policy & provenance",
    "owasp web top 10 — application security lens": "owasp web top 10",
    "owasp genai/llm top 10 — ai application security lens": "owasp llm top 10",
  };
  const expectedNorm = norm(lensName);
  // Tolerant match (the explicit `aliases` map above only catches subtitles
  // seen verbatim before — e.g. Gemini emits "Security Review — Security Review
  // Agent", which no map entry covers). Accept when the emitted name's
  // primary segment (before any —/–/-/:/| subtitle) equals the expected
  // name, or when either name contains the other. The lens keys are
  // distinct enough (cold_read/edge_case/acceptance/security/red_team/policy/
  // owasp-*) that containment cannot cross-match one persona to another.
  //
  // Named, because step 8 below reuses it to identify THIS lens's stray
  // agent comment. Two copies of this rule would drift, and a drifted
  // copy would delete another lens's comment.
  const primary = (s) => s.split(/\s*[—–:|]\s*|\s+-\s+/)[0].trim();
  // The persona's own H1, from the compose step. Its segments are the
  // names a model actually emits, so they are accepted EXACTLY — never by
  // containment. Containment across subtitles would cross-match: the
  // OWASP Web subtitle "Application Security Lens" is a substring of the
  // OWASP LLM subtitle "AI Application Security Lens", so a containment
  // rule would let one lens claim the other's output.
  const heading = String(env.LENS_HEADING || "").trim();
  const headingNames = new Set();
  if (heading) {
    headingNames.add(norm(heading));
    headingNames.add(norm(primary(heading)));
    const parts = heading.split(/\s*[—–:|]\s*|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) headingNames.add(norm(parts.slice(1).join(" ")));
  }
  const matchesThisLens = (name) => {
    const raw = norm(String(name || "").trim());
    if (!raw) return false;
    const n = Object.prototype.hasOwnProperty.call(aliases, raw) ? aliases[raw] : raw;
    return (
      n === expectedNorm ||
      primary(n) === expectedNorm ||
      headingNames.has(n) ||
      n.includes(expectedNorm) ||
      expectedNorm.includes(n)
    );
  };
  if (!matchesThisLens(emittedLens)) {
    return fail(`agent emitted lens="${emittedLens}" but this job is "${lensName}". Re-run this job to retry.`);
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  let findings = Array.isArray(parsed.findings) ? parsed.findings : null;
  if (findings === null) return fail(`JSON missing or non-array \`findings\` (use [] for none). Re-run this job to retry.`);
  for (const f of findings) {
    if (typeof f !== "object" || !f) return fail("a finding is not an object. Re-run this job to retry.");
    if (!SEVERITIES.has(f.severity)) return fail(`finding severity "${f.severity}" not in {MUST FIX, SHOULD FIX, NITPICK}. Re-run this job to retry.`);
    if (typeof f.location !== "string" || !f.location.trim()) return fail("a finding has no \`location\` (file:line). Re-run this job to retry.");
    if (typeof f.detail !== "string" || !f.detail.trim()) return fail("a finding has no \`detail\`. Re-run this job to retry.");
    if (typeof f.recommendation !== "string" || !f.recommendation.trim()) return fail("a finding has no \`recommendation\`. Re-run this job to retry.");
  }
  core.info(`Parsed ${findings.length} finding(s) for "${lensName}".`);

  // ── 3. Render the review body: `## <Lens Name>` + summary + bullets. ──
  const lines = [`## ${lensName}`, ""];
  if (summary) lines.push(`> ${summary}`, "");
  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const f of findings) {
      lines.push(`- [${f.severity}] \`${f.location}\` — ${f.detail}`);
      lines.push(`  - Fix: ${f.recommendation}`);
    }
  }
  const body = lines.join("\n");
  const event = findings.some((f) => f.severity === "MUST FIX") ? "REQUEST_CHANGES" : "COMMENT";

  // ── 4. Build the inline-comment anchor. The GitHub review API requires
  //    a non-empty comments array. Anchor one comment on the first changed
  //    file/line of the diff (deterministic — we compute it, not the
  //    model), plus per-finding comments whose location maps to a real
  //    diff line. Every path MUST come from the actual PR files; an
  //    invented path would 422 the whole review. ──
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  // Map of path -> Set of changed line numbers (from unified-diff hunks).
  // Only count real added lines (`+`, not the `+++ ` file header) so the
  // anchor line is always a valid new-file line number >= 1.
  const changedLinesByPath = new Map();
  for (const f of files) {
    const set = new Set();
    let line = 0;
    for (const h of (f.patch || "").split("\n")) {
      const m = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { line = Number(m[1]); continue; }
      if (h.startsWith("+++") || h.startsWith("---")) continue; // file headers
      if (h.startsWith("+")) { set.add(line); line++; continue; }
      if (h.startsWith("-") || h.startsWith("\\")) continue;
      if (h.startsWith(" ")) line++;
    }
    if (set.size) changedLinesByPath.set(f.filename, set);
  }
  const parseLoc = (loc) => {
    const m = String(loc).match(/^(.+):(\d+)$/);
    return m ? { path: m[1], line: Number(m[2]) } : null;
  };
  const comments = [];
  const used = new Set();
  for (const f of findings) {
    const loc = parseLoc(f.location);
    if (!loc) continue;
    const set = changedLinesByPath.get(loc.path);
    if (!set || !set.has(loc.line)) continue; // not a real diff line — skip
    const key = `${loc.path}:${loc.line}`;
    if (used.has(key)) continue;
    used.add(key);
    comments.push({ path: loc.path, line: loc.line, body: `[${f.severity}] ${f.detail}\n\nFix: ${f.recommendation}` });
  }
  // Fallback anchor: first changed file's first changed line, body="See the review summary."
  if (!comments.length) {
    for (const [path, lines2] of changedLinesByPath) {
      const firstLine = Math.min(...lines2);
      comments.push({ path, line: firstLine, body: "See the review summary." });
      break;
    }
  }
  if (!comments.length) {
    return fail("PR has no changed files to anchor an inline comment on (empty diff?). Cannot post review.");
  }

  // ── 5. Post the review via Octokit (deterministic). ──
  core.info(`Posting review: event=${event}, ${comments.length} inline comment(s), body ${body.length} chars.`);
  let review;
  try {
    review = await github.rest.pulls.createReview({
      owner, repo, pull_number: prNumber,
      commit_id: headSha, body, event, comments,
    });
  } catch (e) {
    return fail(`createReview failed: ${e.message}`);
  }
  core.info(`Posted review id=${review.data.id} on ${headSha.slice(0, 12)}.`);

  // ── 6. Verify it landed on the head SHA (same contract as before). ──
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  const isBot = (r) => r.user && (r.user.login === "github-actions[bot]" || r.user.login === "github-actions");
  const header = `## ${lensName}`;
  // Exact first-line match, NOT a prefix: a bare startsWith would let a
  // lens whose name is a textual prefix of another (e.g. "Security Review" vs
  // "Security Review Plus") claim — and dismiss/collapse — the other lens's
  // reviews and comments. Reachable through ordinary lens-name config,
  // no attacker required.
  const ownsReview = (r) => (r.body || "").split("\n")[0].trim() === header;
  const ok = reviews.some(
    (r) => r.commit_id === headSha && isBot(r) && ownsReview(r),
  );
  core.info(`"${header}" review on ${headSha.slice(0, 12)}: ${ok}`);
  if (!ok) {
    core.setFailed(`Lens "${lensName}" posted a review but it did not land on the head SHA. Re-run this job to retry.`);
  }

  // ── 7. Reconcile: once the new review has landed, dismiss THIS lens's
  //    superseded reviews and collapse their inline comments as OUTDATED,
  //    so re-runs don't pile up stale noise. Best-effort and cosmetic — a
  //    failure here never fails the lens, and the gate already scopes
  //    adjudication to the head SHA.
  //    Superseding is NOT limited to earlier commits. A lens that blocks on
  //    PR-body content (Policy & Provenance: provenance disclosure, the
  //    accountability attestation) is cleared by editing the body, which
  //    changes no SHA — so the clearing re-run lands on the same commit as
  //    the review it supersedes. Skipping those left the old
  //    CHANGES_REQUESTED live, and GitHub's aggregate reviewDecision kept
  //    the PR BLOCKED behind a green Merge Gate. `r.id !== review.data.id`
  //    below is what keeps this safe: a lens never dismisses the review it
  //    just posted.
  //    Each lens only touches its OWN `## <Lens>` reviews (header match),
  //    so lenses running in parallel never collide. ──
  // Parse the opt-out explicitly and fail CLOSED: this collapses comments
  // and dismisses reviews, so only a clearly-truthy value enables it. A
  // non-canonical string (e.g. "0", "no", a typo) disables + warns rather
  // than silently enabling a destructive-ish operation.
  const rawDismiss = String(env.DISMISS_SUPERSEDED ?? "true").trim().toLowerCase();
  const TRUTHY = new Set(["true", "1", "yes", "on"]);
  const FALSY = new Set(["false", "0", "no", "off", ""]);
  const dismissOn = TRUTHY.has(rawDismiss);
  if (!TRUTHY.has(rawDismiss) && !FALSY.has(rawDismiss)) {
    core.warning(`Unrecognized dismiss_superseded value "${env.DISMISS_SUPERSEDED}" — treating as disabled (expected true/false).`);
  }
  if (ok && dismissOn) {
    try {
      const superseded = reviews.filter(
        (r) =>
          isBot(r) &&
          ownsReview(r) &&
          r.commit_id &&
          r.state !== "DISMISSED" &&
          r.id !== review.data.id,
      );
      let dismissed = 0, minimized = 0, warnedMinimize = false;
      // Bound total minimize calls per job: pagination + per-comment
      // GraphQL run serially, and every parallel lens sweeps the same PR,
      // so an old PR with many prior comments could hit GitHub's secondary
      // rate limit or the step timeout. Leftovers are retried next run.
      let minimizeBudget = 200;
      if (superseded.length) {
        const supIds = new Set(superseded.map((r) => r.id));
        const allComments = await github.paginate(github.rest.pulls.listReviewComments, {
          owner, repo, pull_number: prNumber, per_page: 100,
        });
        const byReview = new Map();
        for (const c of allComments) {
          if (!supIds.has(c.pull_request_review_id)) continue;
          (byReview.get(c.pull_request_review_id) || byReview.set(c.pull_request_review_id, []).get(c.pull_request_review_id)).push(c);
        }
        supersededLoop:
        for (const r of superseded) {
          // Collapse this review's inline comments FIRST, and dismiss it only
          // if EVERY comment collapsed. Dismissing first is non-atomic: if a
          // later minimize fails, the review is already DISMISSED and the
          // `superseded` filter excludes it forever, stranding its remaining
          // comments with no retry path. Minimize-first + dismiss-only-if-all
          // makes a partial failure self-heal — the review stays
          // CHANGES_REQUESTED and is retried on the next run.
          let allCollapsed = true;
          for (const c of (byReview.get(r.id) || [])) {
            if (minimizeBudget <= 0) {
              allCollapsed = false;
              core.warning(`Hit the minimize cap (200) reconciling "${lensName}" — leaving the rest for the next run.`);
              break supersededLoop;
            }
            try {
              await github.graphql(
                "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }",
                { id: c.node_id },
              );
              minimized++;
              minimizeBudget--;
            } catch (e) {
              allCollapsed = false; // rate limit / perms — leave un-dismissed so next run retries
              if (!warnedMinimize) {
                core.warning(`minimizeComment failed for a superseded "${lensName}" comment (left un-dismissed for retry): ${e.message}`);
                warnedMinimize = true;
              }
            }
          }
          // dismissReview applies only to CHANGES_REQUESTED / APPROVED; a
          // COMMENTED review can't be dismissed (its comments are collapsed above).
          if (allCollapsed && (r.state === "CHANGES_REQUESTED" || r.state === "APPROVED")) {
            try {
              await github.rest.pulls.dismissReview({
                owner, repo, pull_number: prNumber, review_id: r.id,
                message: `Superseded by the ${lensName} review on ${headSha.slice(0, 7)}.`,
              });
              dismissed++;
            } catch (e) {
              core.info(`  could not dismiss review ${r.id}: ${e.message}`);
            }
          }
        }
        core.info(`Reconciled ${superseded.length} superseded "${lensName}" review(s): collapsed ${minimized} comment(s), dismissed ${dismissed}.`);
      }
    } catch (e) {
      core.warning(`Reconcile step failed (non-fatal): ${e.message}`);
    }
  }

  // ── 8. Delete the agent action's own raw-JSON PR comment. ──
  //    The pi action posts the agent's final message as a top-level PR
  //    comment whenever it has PR context; it has no input to disable
  //    that (checked through v2.27.1). So every lens run leaves a
  //    ```json block on the PR that duplicates the review this step just
  //    rendered, and nothing ever collapses it — `dismiss_superseded`
  //    only reaches reviews and their INLINE comments. They accumulate
  //    per lens per push and drown the actual review.
  //
  //    Deleting is lossless: the same findings are in the `## <Lens>`
  //    review body above. Matching is deliberately narrow — bot-authored,
  //    parses as a JSON object, has a `findings` array, and its `lens`
  //    resolves to THIS lens by the same check used above — so a human
  //    comment, or another lens's comment, is never touched.
  //    Best-effort: a failure here never fails the lens.
  const rawCleanup = String(env.CLEANUP_AGENT_COMMENTS ?? "true").trim().toLowerCase();
  if (new Set(["true", "1", "yes", "on"]).has(rawCleanup)) {
    try {
      const issueComments = await github.paginate(github.rest.issues.listComments, {
        owner, repo, issue_number: prNumber, per_page: 100,
      });
      let deleted = 0;
      let budget = 100; // bound the API calls per job, like the minimize sweep
      for (const c of issueComments) {
        if (budget <= 0) { core.warning(`Hit the agent-comment cleanup cap (100) for "${lensName}" — leaving the rest for the next run.`); break; }
        if (!isBot(c)) continue;
        const body = String(c.body || "");
        // Cheap reject before parsing: the agent's message is JSON, and
        // an ordinary human or bot comment is not.
        if (!/^\s*(```(?:json)?)?\s*\{/.test(body)) continue;
        let obj = null;
        try { obj = JSON.parse(body.replace(/```(?:json)?/gi, "").trim()); } catch (_) { continue; }
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.findings)) continue;
        const claimed = String(obj.lens || "").trim();
        if (!claimed || !matchesThisLens(claimed)) continue;
        budget--;
        try {
          await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
          deleted++;
        } catch (e) {
          core.info(`  could not delete agent comment ${c.id}: ${e.message}`);
        }
      }
      if (deleted) core.info(`Removed ${deleted} duplicate raw-JSON agent comment(s) for "${lensName}".`);
    } catch (e) {
      core.warning(`Agent-comment cleanup failed (non-fatal): ${e.message}`);
    }
  }
}

module.exports = { run };
