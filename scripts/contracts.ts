/**
 * Minimal contracts substrate for emergent contract coding.
 *
 * Subcommands:
 *   contracts generate            — regenerate .contracts/registry.json from src/**
 *   contracts check               — regenerate and compare; exit 1 on drift (registry is never hand-edited)
 *   contracts affected --diff REF — list exported interfaces changed since REF and their call sites
 *   contracts log append KIND TEXT — append a structured-pass entry to .contracts/log.jsonl
 *   contracts log check           — validate every log entry (known kind, non-empty text)
 *
 * Registry format: one JSON object per exported declaration:
 *   { file, name, kind, sig }
 * `sig` is the declaration's signature text: full text for type aliases and
 * interfaces, text up to the first "{" for classes, functions, enums, and vars.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const CONTRACTS_DIR = join(ROOT, ".contracts");
const REGISTRY = join(CONTRACTS_DIR, "registry.json");
const LOG = join(CONTRACTS_DIR, "log.jsonl");
const KINDS = ["merge", "divorce", "leave", "divergence", "unresolved", "wish-declined"];

interface Entry {
  file: string;
  name: string;
  kind: string;
  sig: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function signatureText(decl: ts.Node): string {
  const text = decl.getText();
  const brace = text.indexOf("{");
  const isTypeLike =
    ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl);
  if (isTypeLike || brace === -1) return text.replace(/\s+/g, " ").trim();
  return text.slice(0, brace).replace(/\s+/g, " ").trim();
}

function extract(file: string): Entry[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const entries: Entry[] = [];
  for (const stmt of source.statements) {
    if (
      (ts.isExportDeclaration(stmt) && !stmt.exportClause) ||
      (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly)
    ) {
      continue;
    }
    const modifiers = ts.canHaveModifiers(stmt)
      ? ts.getModifiers(stmt)
      : undefined;
    const exported =
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
      (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined);
    if (!exported) continue;

    if (ts.isExportDeclaration(stmt) && ts.isNamedExports(stmt.exportClause!)) {
      for (const el of stmt.exportClause!.elements) {
        entries.push({
          file: relative(ROOT, file),
          name: el.name.text,
          kind: "re-export",
          sig: `re-export of ${el.name.text}`,
        });
      }
      continue;
    }
    const name = (stmt as ts.DeclarationStatement).name?.getText();
    if (!name) continue;
    entries.push({
      file: relative(ROOT, file),
      name,
      kind: ts.SyntaxKind[stmt.kind],
      sig: signatureText(stmt),
    });
  }
  return entries;
}

function generateRegistry(): Entry[] {
  const entries = listFiles(join(ROOT, "src")).flatMap(extract);
  entries.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
  return entries;
}

function check(): number {
  const generated = generateRegistry();
  if (!existsSync(REGISTRY)) {
    console.error("contracts check: registry missing — run `contracts generate` first");
    return 1;
  }
  const current = JSON.parse(readFileSync(REGISTRY, "utf8")) as Entry[];
  const a = JSON.stringify(current, null, 2);
  const b = JSON.stringify(generated, null, 2);
  if (a !== b) {
    console.error("contracts check: registry drift detected (regenerate, never hand-edit)");
    return 1;
  }
  console.log(`contracts check: OK (${current.length} exports)`);
  return 0;
}

function affected(ref: string): number {
  const diff = execSync(`git diff --unified=0 ${ref} -- src`, {
    cwd: ROOT,
    encoding: "utf8",
  });
  const changedFiles = new Set(
    diff
      .split("\n")
      .filter((l) => l.startsWith("+++") || l.startsWith("---"))
      .map((l) => l.slice(4).trim().replace(/^[ab]\//, ""))
      .filter((l) => l !== "/dev/null"),
  );
  const registry = existsSync(REGISTRY)
    ? (JSON.parse(readFileSync(REGISTRY, "utf8")) as Entry[])
    : generateRegistry();
  const changedExports = registry.filter((e) => changedFiles.has(e.file));
  if (changedExports.length === 0) {
    console.log(`contracts affected: no exported interfaces changed since ${ref}`);
    return 0;
  }
  console.log(`contracts affected: ${changedExports.length} exports changed since ${ref}:`);
  for (const e of changedExports) {
    console.log(`  ${e.file}: ${e.name} (${e.kind})`);
    const grep = execSync(
      `grep -rn --include='*.ts' '\\b${e.name}\\b' src test | grep -v '^${e.file}' || true`,
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    if (grep) console.log(grep.replace(/^/gm, "    "));
    else console.log("    (no call sites outside definition file)");
  }
  return 0;
}

function logAppend(kind: string, text: string): number {
  if (!KINDS.includes(kind)) {
    console.error(`contracts log append: unknown kind "${kind}" (legal: ${KINDS.join(", ")})`);
    return 1;
  }
  if (!text.trim()) {
    console.error("contracts log append: entry text must not be empty");
    return 1;
  }
  const entry = {
    ts: new Date().toISOString(),
    kind,
    text: text.trim(),
  };
  writeFileSync(LOG, `${JSON.stringify(entry)}\n`, { flag: "a" });
  console.log(`contracts log append: recorded ${kind}`);
  return 0;
}

function logCheck(): number {
  if (!existsSync(LOG)) {
    console.log("contracts log check: OK (no log yet)");
    return 0;
  }
  const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    let e: { kind?: string; text?: string };
    try {
      e = JSON.parse(lines[i]);
    } catch {
      console.error(`contracts log check: line ${i + 1} is not valid JSON`);
      return 1;
    }
    if (!e.kind || !KINDS.includes(e.kind)) {
      console.error(`contracts log check: line ${i + 1} has unknown kind "${e.kind}"`);
      return 1;
    }
    if (typeof e.text !== "string" || e.text.trim() === "") {
      console.error(`contracts log check: line ${i + 1} has empty text`);
      return 1;
    }
  }
  console.log(`contracts log check: OK (${lines.length} entries)`);
  return 0;
}

const [cmd, sub, ...rest] = process.argv.slice(2);
let code = 1;
if (cmd === "generate") {
  mkdirSync(CONTRACTS_DIR, { recursive: true });
  writeFileSync(REGISTRY, `${JSON.stringify(generateRegistry(), null, 2)}\n`);
  console.log(`contracts generate: wrote ${REGISTRY}`);
  code = 0;
} else if (cmd === "check") {
  code = check();
} else if (cmd === "affected" && sub === "--diff" && rest[0]) {
  code = affected(rest[0]);
} else if (cmd === "log" && sub === "append" && rest.length >= 2) {
  code = logAppend(rest[0], rest.slice(1).join(" "));
} else if (cmd === "log" && sub === "check") {
  code = logCheck();
} else {
  console.error(
    "usage: contracts generate|check|affected --diff REF|log append KIND TEXT...|log check",
  );
}
process.exit(code);
