// Local generated artifacts must never follow repository-provided symlinks.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function statOrMissing(file) {
  try { return fs.lstatSync(file); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function prepareOutput(file) {
  const absolute = path.resolve(file);
  const { root } = path.parse(absolute);
  const parts = absolute.slice(root.length).split(path.sep);
  if (parts.includes(".git")) throw new Error(`refusing generated output in Git metadata: ${absolute}`);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat = statOrMissing(current);
    if (!stat) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing symlink or non-directory output component: ${current}`);
  }
  const stat = statOrMissing(absolute);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`refusing symlink or non-regular output file: ${absolute}`);
  return absolute;
}

function writeOutput(file, data) {
  const absolute = prepareOutput(file);
  const temporary = path.join(path.dirname(absolute), `.bpr-output-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    // Recheck immediately before replacement; rename never follows the final
    // component, and our temporary file was created exclusively as regular.
    prepareOutput(absolute);
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { prepareOutput, writeOutput };
