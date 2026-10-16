// Stage 2 of the review corpus: deterministic, model-free filtering.
//
// The unit is a review round (one PR at one reviewed head). Each round either
// becomes a candidate case or is rejected with every applicable reason from a
// closed enum. Rejection is reserved for rounds that cannot be used at all;
// properties that only rule a case out of one slice are recorded as notes, so
// the decision stays with the slice that cares.

import { mustFixItems } from "./review-formats.mjs";

export const REJECT = Object.freeze({
  noDiff: "no_diff",
  diffTooLarge: "diff_too_large",
  supersededRound: "superseded_round",
  unparseableReview: "unparseable_review",
  unclassifiedPipeline: "unclassified_pipeline",
  policyOnlyBlock: "policy_only_block",
  generatedOnly: "generated_only",
});

export const NOTE = Object.freeze({
  noAcceptanceCriteria: "no_acceptance_criteria",
});

// Lockfiles, vendored and generated output: a diff made only of these says
// nothing about whether a reviewer judged code well.
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|\.terraform\.lock\.hcl)$/,
  /(^|\/)(vendor|node_modules)\//,
  /\.(min\.js|min\.css|map|snap)$/,
  /(^|\/)CHANGELOG\.md$/,
];

const ACCEPTANCE = /acceptance criteria|^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?\**AC[-\s]?\d+\b|^#{1,4}\s*(?:ACs?|Definition of done)\b/im;

// What a policy finding says when its only complaint is the unticked
// human-accountability or AI-provenance box rather than anything in the code.
// Anchored to the box and the disclosure themselves, so a real policy finding
// (a removed SLSA attestation, a UI checkbox bug) never reads as box-only.
const ACCOUNTABILITY = /accountab\w*\s+(?:box|checkbox|attestation|line)|human[- ]accountab|has reviewed this change|human[- ]review\w*\s+(?:box|checkbox)|(?:AI[- ])?provenance (?:disclosure|block)|discloses the harness|Baseline (?:policy )?rule [12]\b/i;
const POLICY_LENS = /polic|compliance/i;

/** Per-file added/removed line counts from a unified diff. */
export function diffstat(diff) {
  const files = [];
  let current = null;
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2], added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added++;
    else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed++;
  }
  return files;
}

export const isGenerated = (path) => GENERATED.some((re) => re.test(path));

function mustFixTexts(output) {
  if (Array.isArray(output.findings)) return output.findings.filter((f) => f.severity === "MUST FIX").map((f) => `${f.detail ?? ""} ${f.recommendation ?? ""}`);
  const tagged = output.body.split("\n").filter((l) => /\[MUST FIX\]/.test(l));
  return tagged.length ? tagged : (mustFixItems(output.body) ?? []).map((it) => it.text);
}

/** True when every blocking output is a policy lens objecting only to the accountability box. */
export function isPolicyOnlyBlock(outputs) {
  const blocking = outputs.filter((o) => o.verdict === "BLOCK" || o.severity === "MUST FIX");
  if (!blocking.length) return false;
  return blocking.every((o) => {
    // A summary table: every BLOCK row must be a policy lens whose row (or the
    // comment) shows the complaint is the accountability box.
    if (o.lensVerdicts?.length) {
      const rows = o.lensVerdicts.filter((r) => r.verdict === "BLOCK");
      if (!rows.length || !rows.every((r) => POLICY_LENS.test(r.lens))) return false;
      if (rows.every((r) => ACCOUNTABILITY.test(r.text))) return true;
      // Row text too terse: every MUST FIX item in the comment must be the box.
      const items = mustFixItems(o.body) ?? [];
      return items.length > 0 && items.every((it) => ACCOUNTABILITY.test(it.text));
    }
    if (!POLICY_LENS.test(o.lens ?? "")) return false;
    const texts = mustFixTexts(o);
    return texts.length > 0 && texts.every((t) => ACCOUNTABILITY.test(t));
  });
}

/** Decide every round of one harvested snapshot. */
export function filterSnapshot(snapshot) {
  const latest = snapshot.rounds.reduce((a, r) => (!a || r.reviewedAt > a.reviewedAt ? r : a), null);
  return snapshot.rounds.map((round) => {
    const reasons = [];
    const notes = [];
    if (round.diffError === "too_large") reasons.push(REJECT.diffTooLarge);
    else if (typeof round.diff !== "string" || !round.diff.trim()) reasons.push(REJECT.noDiff);
    if (round !== latest) reasons.push(REJECT.supersededRound);
    const outputs = round.outputs;
    if (outputs.every((o) => o.pipeline === "unclassified")) reasons.push(REJECT.unclassifiedPipeline);
    else if (!outputs.some((o) => o.verdict || o.severity || o.findings || o.lens)) reasons.push(REJECT.unparseableReview);
    if (isPolicyOnlyBlock(outputs)) reasons.push(REJECT.policyOnlyBlock);
    const stat = typeof round.diff === "string" ? diffstat(round.diff) : [];
    if (stat.length && stat.every((f) => isGenerated(f.path))) reasons.push(REJECT.generatedOnly);
    if (!ACCEPTANCE.test(round.body ?? "")) notes.push(NOTE.noAcceptanceCriteria);
    return {
      caseId: `${snapshot.id}@${(round.headSha ?? "unknown").slice(0, 12)}`,
      snapshotId: snapshot.id,
      headSha: round.headSha,
      reviewedAt: round.reviewedAt,
      accepted: reasons.length === 0,
      reasons,
      notes,
      flags: round.flags,
      pipelines: [...new Set(outputs.map((o) => o.pipeline))],
      lenses: [...new Set(outputs.map((o) => o.lens).filter(Boolean))],
      diffstat: stat,
    };
  });
}

/** Counts per reason and note, so a filter change is visible as a number. */
export function summarize(decisions) {
  const count = (key) => decisions.flatMap((d) => d[key]).reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  return {
    rounds: decisions.length,
    accepted: decisions.filter((d) => d.accepted).length,
    rejectedBy: count("reasons"),
    notes: count("notes"),
    acceptedFlags: decisions.filter((d) => d.accepted).flatMap((d) => d.flags).reduce((acc, f) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {}),
  };
}
