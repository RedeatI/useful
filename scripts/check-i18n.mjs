#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "apps", "useful", "src");
const jsonMode = process.argv.includes("--json");
const HAN = /\p{Script=Han}/u;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith(".vue")) files.push(absolute);
  }
  return files;
}

function lineOf(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function stripHtmlComments(source) {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<!--", cursor);
    if (start < 0) return result + source.slice(cursor);
    const end = source.indexOf("-->", start + 4);
    if (end < 0) return result + source.slice(cursor);
    result += source.slice(cursor, start);
    cursor = end + 3;
  }
  return result;
}

const violations = [];
const files = (await walk(sourceRoot)).sort();
for (const absolute of files) {
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  const source = await readFile(absolute, "utf8");
  const templateMatch = /<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/i.exec(source);
  if (templateMatch) {
    const visibleTemplate = stripHtmlComments(templateMatch[1]);
    const han = visibleTemplate.search(HAN);
    if (han >= 0) {
      const offset = templateMatch.index + templateMatch[0].indexOf(templateMatch[1]) + han;
      violations.push({ file: relative, line: lineOf(source, offset), code: "hardcoded-template-han" });
    }
  }

  const scriptMatch = /<script\s+setup(?:\s[^>]*)?>([\s\S]*?)<\/script>/i.exec(source);
  if (!scriptMatch) continue;
  const script = scriptMatch[1];
  const ast = ts.createSourceFile(relative, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function inspect(node) {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      HAN.test(node.text)
    ) {
      const offset = scriptMatch.index + scriptMatch[0].indexOf(script) + node.getStart(ast);
      violations.push({ file: relative, line: lineOf(source, offset), code: "hardcoded-script-han" });
    }
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
}

const result = {
  schemaVersion: "useful.i18n-check.v1",
  ok: violations.length === 0,
  componentCount: files.length,
  violations,
};

if (jsonMode) process.stdout.write(`${JSON.stringify(result)}\n`);
else {
  process.stdout.write(`Useful i18n: ${result.ok ? "PASS" : "FAIL"}; components=${files.length}; violations=${violations.length}\n`);
  for (const violation of violations) {
    process.stderr.write(`- ${violation.file}:${violation.line} ${violation.code}\n`);
  }
}
process.exitCode = result.ok ? 0 : 1;
