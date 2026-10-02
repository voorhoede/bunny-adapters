#!/usr/bin/env node
/**
 * The style rules a formatter cannot hold.
 *
 * Prettier keeps the indent and the quotes. Everything else in
 * `docs/writing-an-adapter.md` is prose, and prose does not survive twenty
 * merges. This script is the part that does.
 *
 *   npm run check:style
 *
 * Two kinds of rule live here. The platform rules come from Edge Scripting, and
 * they hold for every package: a script has 10 MB and 500 ms, and one file runs
 * on the edge, on Deno and under a test. The framework rules come from the
 * adapter's own framework, and they differ per package, so `PACKAGES` below
 * carries them. Adding Nuxt means adding one row, and a Nitro preset wants the
 * opposite import extension.
 *
 * Every failure says what it found, why the rule exists, and which section of
 * `docs/writing-an-adapter.md` states it. A check that only prints "failed"
 * teaches nobody.
 *
 * It reads the real syntax tree, with the TypeScript the packages already
 * depend on. A regular expression over the text would fire on the word `any`
 * inside a comment, and miss `x!` inside a template.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * One row per package. The framework decides every value here, so read the
 * framework's own adapters before you change one.
 */
const PACKAGES = [
  {
    dir: "packages/astro",
    framework: "Astro",
    /** Where the script starts. Everything these reach is bundled and shipped. */
    runtimeEntries: [
      "src/server.ts",
      "src/middleware.ts",
      "src/session.ts",
      "src/cache.ts",
      "src/image-service.ts",
    ],
    /** Astro's build-time entries. A failure here is one the user has to fix. */
    buildEntries: ["src/index.ts", "src/preview.ts"],
    /** Every official Astro adapter writes the extension. A Nitro preset writes `.ts`. */
    importExtension: ".js",
    /**
     * Imports no shipped module may carry. `astro/errors` is Astro's own code,
     * and `esbuild` is a build tool: one import of either puts megabytes in a
     * script that has ten. `node:` built-ins are not on this list, because the
     * runtime provides them, `node:fs` included.
     */
    denyInBundle: ["astro/errors", "esbuild"],
    /** One class in about 6,700 lines of official adapter code. */
    allowClass: false,
  },
];

/** A failure: where it is, what it says, and where the rule is written down. */
const failures = [];

function fail(rule, file, line, found, why, section) {
  failures.push({ rule, file, line, found, why, section });
}

/** Every `.ts` file under a directory, as repository-relative paths. */
function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function parse(file) {
  const text = readFileSync(path.join(repo, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/** The 1-based line a node starts on. */
function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** The node's own line of source, trimmed, for the report. */
function textOf(source, node) {
  const start = source.getLineStarts()[lineOf(source, node) - 1];
  const end = source.text.indexOf("\n", start);
  return source.text.slice(start, end === -1 ? undefined : end).trim();
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Every import and export specifier in a file, with its node.
 *
 * `typeOnly` says the whole declaration is erased at compile time. Such an
 * import reaches no bundle, so the rules about what a script may hold skip it.
 */
function specifiers(source) {
  const found = [];
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? (node.importClause?.isTypeOnly ?? false)
        : node.isTypeOnly;
      found.push({ text: node.moduleSpecifier.text, node, typeOnly });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ text: node.arguments[0].text, node, typeOnly: false });
    }
  });
  return found;
}

/**
 * The files the bundle reaches, from the runtime entries outward.
 *
 * Everything under `src/runtime/` counts too, whether an entry imports it today
 * or not: that directory exists to say "this ships".
 */
function bundleReaches(pkg) {
  const reached = new Set();
  const queue = pkg.runtimeEntries.map((entry) => path.join(pkg.dir, entry));
  const runtimeDir = path.join(repo, pkg.dir, "src/runtime");
  for (const file of sourceFiles(runtimeDir)) queue.push(path.relative(repo, file));

  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { text, typeOnly } of specifiers(parse(file))) {
      if (typeOnly || !text.startsWith(".")) continue;
      const target = path
        .join(path.dirname(file), text)
        .replace(/\.js$/, ".ts")
        .replace(/\.ts$/, ".ts");
      const resolved = target.endsWith(".ts") ? target : `${target}.ts`;
      try {
        statSync(path.join(repo, resolved));
      } catch {
        continue;
      }
      queue.push(resolved);
    }
  }
  return reached;
}

/** The function a node sits in, by name, or undefined at the top level. */
function enclosingFunctionName(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
      return parent.name?.getText();
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer) return parent.name.getText();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The platform rules. Edge Scripting forces these, and no framework overrides
// them. See "What every adapter shares".
// ---------------------------------------------------------------------------

/**
 * The environment is read through one helper, and never at the call site.
 *
 * A call site that reads `process.env` works on Deno and returns undefined on
 * the edge, or the other way round, and the failure looks like a configuration
 * mistake. Only the shipped modules are checked: a build script runs on Node,
 * where `process.env` is the right answer.
 */
function checkEnvHelper(pkg, shipped) {
  for (const file of shipped) {
    const source = parse(file);
    walk(source, (node) => {
      if (!ts.isPropertyAccessExpression(node)) return;
      const text = node.getText(source);
      if (text !== "process.env" && text !== "Deno.env") return;
      if (enclosingFunctionName(node) === "env") return;
      fail(
        "env-helper",
        file,
        lineOf(source, node),
        textOf(source, node),
        `${text} outside the env() helper. One file runs on the edge, on Deno and under a ` +
          "test, so the reading of it belongs in one place.",
        "What every adapter shares",
      );
    });
  }
}

/**
 * Nothing the bundle reaches imports from `src/build/`, or from the deny list.
 *
 * `build/bundle.ts` imports esbuild. One import of it from a shipped module
 * puts esbuild in the script, and the script stops starting.
 */
function checkBundleImports(pkg, shipped) {
  for (const file of shipped) {
    const source = parse(file);
    for (const { text, node, typeOnly } of specifiers(source)) {
      // An `import type` is erased, so it reaches no script.
      if (typeOnly) continue;
      const target = text.startsWith(".") ? path.join(path.dirname(file), text) : "";
      if (target.startsWith(path.join(pkg.dir, "src/build"))) {
        fail(
          "no-build-in-bundle",
          file,
          lineOf(source, node),
          textOf(source, node),
          "A shipped module imports src/build/. That tree is build-only, and bundle.ts imports " +
            "esbuild, so one import of it puts a build tool in a script that has 10 MB.",
          "Package layout",
        );
      }
      if (pkg.denyInBundle.some((deny) => text === deny || text.startsWith(`${deny}/`))) {
        fail(
          "deny-list",
          file,
          lineOf(source, node),
          textOf(source, node),
          `A shipped module imports "${text}", which is on this package's deny list. It is ` +
            "build-time code, and the script has 10 MB and 500 ms to start.",
          "What every adapter shares",
        );
      }
    }
  }
}

/**
 * No `any`, and no `!` non-null assertion, anywhere in `src/`.
 *
 * Both are absent today. Each one arrives one merge at a time, and each one
 * turns a compile-time answer into a runtime surprise on a platform where the
 * surprise is a 400 with no body.
 */
function checkTypeEscapes(pkg, files) {
  for (const file of files) {
    const source = parse(file);
    walk(source, (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        fail(
          "no-any",
          file,
          lineOf(source, node),
          textOf(source, node),
          "`any` turns off the checker for everything downstream of it. `unknown` with a " +
            "narrowing, or the real type, keeps the answer.",
          "What every adapter shares",
        );
      }
      if (ts.isNonNullExpression(node)) {
        fail(
          "no-non-null",
          file,
          lineOf(source, node),
          textOf(source, node),
          "`!` says a value is there and proves nothing. On the edge the proof arrives as a " +
            "500 on one request. Check it, or default it.",
          "What every adapter shares",
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// The framework rules. These come from the framework's own adapters, and they
// differ per package. See "What every adapter takes from its framework".
// ---------------------------------------------------------------------------

/** Astro adapters are functions, factories and plain data. */
function checkNoClass(pkg, files) {
  if (pkg.allowClass) return;
  for (const file of files) {
    const source = parse(file);
    walk(source, (node) => {
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return;
      fail(
        "no-class",
        file,
        lineOf(source, node),
        textOf(source, node),
        `${pkg.framework} adapters are written with functions and plain data. Every contract ` +
          "the framework offers is an object literal, a method with no `this` survives being " +
          "passed as a callback, and class machinery is bytes in a script.",
        pkg.framework,
      );
    });
  }
}

/** Every relative import carries the extension the framework writes. */
function checkImportExtension(pkg, files) {
  for (const file of files) {
    const source = parse(file);
    for (const { text, node } of specifiers(source)) {
      if (!text.startsWith(".")) continue;
      if (text.endsWith(pkg.importExtension)) continue;
      fail(
        "import-extension",
        file,
        lineOf(source, node),
        textOf(source, node),
        `Every relative import in a ${pkg.framework} adapter ends in ` +
          `"${pkg.importExtension}". An extensionless import resolves under a bundler and ` +
          "fails on the runtime.",
        pkg.framework,
      );
    }
  }
}

/**
 * A build failure is the framework's own error type.
 *
 * Astro renders `AstroError` in its error box and prints the hint under the
 * message. A plain `Error` from a build hook arrives as a stack trace.
 */
function checkBuildFailures(pkg) {
  for (const entry of pkg.buildEntries) {
    const file = path.join(pkg.dir, entry);
    const source = parse(file);
    walk(source, (node) => {
      if (!ts.isThrowStatement(node)) return;
      const thrown = node.expression;
      if (!ts.isNewExpression(thrown) || thrown.expression.getText(source) !== "Error") return;
      fail(
        "framework-error",
        file,
        lineOf(source, node),
        textOf(source, node),
        `A build failure in a ${pkg.framework} adapter throws AstroError from astro/errors, ` +
          "so the message and the hint are printed apart. A plain Error is a stack trace, and " +
          "the advice is buried in it.",
        pkg.framework,
      );
    });
  }
}

// ---------------------------------------------------------------------------

for (const pkg of PACKAGES) {
  const srcDir = path.join(repo, pkg.dir, "src");
  const files = sourceFiles(srcDir).map((file) => path.relative(repo, file));
  const shipped = [...bundleReaches(pkg)];

  checkEnvHelper(pkg, shipped);
  checkBundleImports(pkg, shipped);
  checkTypeEscapes(pkg, files);
  checkNoClass(pkg, files);
  checkImportExtension(pkg, files);
  checkBuildFailures(pkg);
}

if (failures.length === 0) {
  console.log(`Style: ${PACKAGES.length} package(s) checked, every rule passes.`);
  process.exit(0);
}

for (const failure of failures) {
  console.error(`\n${failure.file}:${failure.line}  [${failure.rule}]`);
  console.error(`  ${failure.found}`);
  console.error(`  Why: ${failure.why}`);
  console.error(`  Rule: docs/writing-an-adapter.md, "${failure.section}"`);
}
console.error(`\n${failures.length} style failure(s).`);
process.exit(1);
