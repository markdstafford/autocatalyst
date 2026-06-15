import ts from 'typescript';
import type { ConvergenceRoundFinding } from '@autocatalyst/api-contract';
import type { CheckpointAltitude } from './run-workspace-git.js';

export interface ValidateAltitudeContractInput {
  readonly altitude: CheckpointAltitude;
  readonly headCommitSha: string;
  readonly changedFiles: readonly string[];
  readonly readFileAtRef: (path: string) => Promise<string | null>;
}

const TEST_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /\.spec\.[a-z]+$/i,
  /\.test\.[a-z]+$/i,
  /(^|\/)__tests__\//,
  /(^|\/)tests\//
];

const NON_TS_SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.cpp', '.c', '.cs'
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function getExtension(path: string): string {
  const norm = normalizePath(path);
  const slash = norm.lastIndexOf('/');
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function isTestFile(path: string): boolean {
  const norm = normalizePath(path);
  return TEST_FILE_PATTERNS.some(re => re.test(norm));
}

function makeFinding(args: {
  altitude: CheckpointAltitude;
  normPath: string;
  ruleId: string;
  title: string;
  body: string;
}): ConvergenceRoundFinding {
  const key = `altitude_contract:${args.altitude}:${args.normPath}:${args.ruleId}`;
  return {
    feedbackId: key,
    title: args.title,
    body: args.body,
    severity: 'blocker',
    source: 'altitude_contract',
    category: 'contract_violation',
    altitude: args.altitude,
    blocking: true,
    signature: key,
    deterministicKey: key,
    sourcePath: args.normPath
  };
}

function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
  return modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);
}

function isAllowedClassMember(member: ts.ClassElement): boolean {
  // Allowed: signatures only — no bodies, no initializers.
  if (ts.isConstructorDeclaration(member)) {
    return member.body === undefined;
  }
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return (member as ts.FunctionLikeDeclaration).body === undefined;
  }
  if (ts.isPropertyDeclaration(member)) {
    return member.initializer === undefined;
  }
  if (ts.isIndexSignatureDeclaration(member) || ts.isSemicolonClassElement(member)) {
    return true;
  }
  if (ts.isClassStaticBlockDeclaration(member)) {
    return false;
  }
  return false;
}

function checkClass(
  node: ts.ClassDeclaration,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  if (hasDeclareModifier(node)) return [];
  const allMembersSignatureOnly = node.members.every(isAllowedClassMember);
  if (allMembersSignatureOnly) return [];
  return [
    makeFinding({
      altitude,
      normPath,
      ruleId: 'has_function_body',
      title: 'Early altitude contract violation',
      body: `Class in ${normPath} contains member bodies or initializers; only signatures are allowed at altitude ${altitude}.`
    })
  ];
}

function checkFunctionDecl(
  node: ts.FunctionDeclaration,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  if (node.body === undefined) return [];
  return [
    makeFinding({
      altitude,
      normPath,
      ruleId: 'has_function_body',
      title: 'Early altitude contract violation',
      body: `Function in ${normPath} has an executable body; only signatures or 'declare function' are allowed at altitude ${altitude}.`
    })
  ];
}

function checkVariableStatement(
  node: ts.VariableStatement,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  if (hasDeclareModifier(node)) return [];
  const hasInitializer = node.declarationList.declarations.some(d => d.initializer !== undefined);
  if (!hasInitializer) return [];
  return [
    makeFinding({
      altitude,
      normPath,
      ruleId: 'top_level_initializer',
      title: 'Early altitude contract violation',
      body: `Top-level variable in ${normPath} has an initializer; only 'declare const/let/var' is allowed at altitude ${altitude}.`
    })
  ];
}

function checkEnum(
  node: ts.EnumDeclaration,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  if (hasDeclareModifier(node)) return [];
  return [
    makeFinding({
      altitude,
      normPath,
      ruleId: 'runtime_enum',
      title: 'Early altitude contract violation',
      body: `Enum in ${normPath} is a runtime construct; use 'declare enum' or a string-literal union at altitude ${altitude}.`
    })
  ];
}

function checkImport(
  node: ts.ImportDeclaration,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  // Side-effect import: no importClause.
  if (node.importClause === undefined) {
    return [
      makeFinding({
        altitude,
        normPath,
        ruleId: 'side_effect_import',
        title: 'Early altitude contract violation',
        body: `Side-effect import in ${normPath} executes code at load time; not allowed at altitude ${altitude}.`
      })
    ];
  }
  return [];
}

function checkStatement(
  node: ts.Statement,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return [];
  if (ts.isImportDeclaration(node)) return checkImport(node, altitude, normPath);
  if (ts.isExportDeclaration(node)) return []; // re-exports/type exports allowed
  if (ts.isImportEqualsDeclaration(node)) {
    // `import x = require(...)` is runtime — block it.
    return [
      makeFinding({
        altitude,
        normPath,
        ruleId: 'import_equals',
        title: 'Early altitude contract violation',
        body: `'import = require(...)' in ${normPath} is runtime-only; not allowed at altitude ${altitude}.`
      })
    ];
  }
  if (ts.isFunctionDeclaration(node)) return checkFunctionDecl(node, altitude, normPath);
  if (ts.isClassDeclaration(node)) return checkClass(node, altitude, normPath);
  if (ts.isVariableStatement(node)) return checkVariableStatement(node, altitude, normPath);
  if (ts.isEnumDeclaration(node)) return checkEnum(node, altitude, normPath);
  if (ts.isModuleDeclaration(node)) {
    // namespace/module — allow only when ambient or body holds only allowed declarations.
    if (hasDeclareModifier(node)) return [];
    // Recurse into the module body — ModuleBlock (normal namespace) or nested ModuleDeclaration (dotted A.B namespaces).
    if (node.body && ts.isModuleBlock(node.body)) {
      return node.body.statements.flatMap(s => checkStatement(s, altitude, normPath));
    }
    if (node.body && ts.isModuleDeclaration(node.body)) {
      return checkStatement(node.body, altitude, normPath);
    }
    return [];
  }
  // Anything else at the top level is an executable statement.
  return [
    makeFinding({
      altitude,
      normPath,
      ruleId: 'top_level_statement',
      title: 'Early altitude contract violation',
      body: `Top-level executable statement in ${normPath} is not allowed at altitude ${altitude}; only type declarations and ambient signatures are permitted.`
    })
  ];
}

function hasTsParseErrors(sourceFile: ts.SourceFile): boolean {
  // parseDiagnostics is an internal TypeScript API not exposed in the public types,
  // but it is stable and populated by createSourceFile (unlike getSyntacticDiagnostics
  // which requires a full program). We access it via cast to detect malformed TypeScript.
  const internal = sourceFile as unknown as { parseDiagnostics?: ReadonlyArray<{ category: number }> };
  return (internal.parseDiagnostics?.length ?? 0) > 0;
}

function validateTsFile(
  sourceText: string,
  altitude: CheckpointAltitude,
  normPath: string
): ConvergenceRoundFinding[] {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(normPath, sourceText, ts.ScriptTarget.Latest, true);
  } catch {
    return [
      makeFinding({
        altitude,
        normPath,
        ruleId: 'parse_failure',
        title: 'Early altitude contract violation',
        body: `Could not parse ${normPath} as TypeScript; resolve syntax errors before checkpointing at altitude ${altitude}.`
      })
    ];
  }
  if (hasTsParseErrors(sourceFile)) {
    return [
      makeFinding({
        altitude,
        normPath,
        ruleId: 'parse_failure',
        title: 'Early altitude contract violation',
        body: `Could not parse ${normPath} as TypeScript; resolve syntax errors before checkpointing at altitude ${altitude}.`
      })
    ];
  }
  const findings: ConvergenceRoundFinding[] = [];
  for (const stmt of sourceFile.statements) {
    findings.push(...checkStatement(stmt, altitude, normPath));
  }
  // Dedupe by deterministicKey while preserving order.
  const seen = new Set<string>();
  const unique: ConvergenceRoundFinding[] = [];
  for (const f of findings) {
    const k = f.deterministicKey ?? f.signature;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
  }
  return unique;
}

export async function validateAltitudeContract(
  input: ValidateAltitudeContractInput
): Promise<ConvergenceRoundFinding[]> {
  const out: ConvergenceRoundFinding[] = [];
  for (const path of input.changedFiles) {
    const normPath = normalizePath(path);
    const ext = getExtension(normPath);

    // 1) Test files → always blocking at early altitudes.
    if (isTestFile(normPath)) {
      // Only emit if file still exists (i.e. was added or modified, not deleted).
      const text = await input.readFileAtRef(path);
      if (text === null) continue;
      out.push(
        makeFinding({
          altitude: input.altitude,
          normPath,
          ruleId: 'is_test_file',
          title: 'Early altitude contract violation',
          body: `Test file ${normPath} should not be added or modified at altitude ${input.altitude}; tests belong to the build altitude.`
        })
      );
      continue;
    }

    // 2) JSX files → blocking.
    if (ext === '.tsx') {
      const text = await input.readFileAtRef(path);
      if (text === null) continue;
      out.push(
        makeFinding({
          altitude: input.altitude,
          normPath,
          ruleId: 'is_jsx_file',
          title: 'Early altitude contract violation',
          body: `JSX file ${normPath} contains executable markup; not allowed at altitude ${input.altitude}.`
        })
      );
      continue;
    }

    // 3) Non-TS source → blocking when present.
    if (NON_TS_SOURCE_EXTENSIONS.has(ext)) {
      const text = await input.readFileAtRef(path);
      if (text === null) continue;
      out.push(
        makeFinding({
          altitude: input.altitude,
          normPath,
          ruleId: 'non_ts_source',
          title: 'Early altitude contract violation',
          body: `Non-TypeScript source file ${normPath} is not permitted at altitude ${input.altitude}; only .ts type declarations are allowed.`
        })
      );
      continue;
    }

    // 4) .ts files → parse and walk.
    if (ext === '.ts' || ext === '.d.ts' || normPath.endsWith('.d.ts')) {
      const text = await input.readFileAtRef(path);
      if (text === null) continue;
      out.push(...validateTsFile(text, input.altitude, normPath));
      continue;
    }
    // Other extensions (md, json, yml, etc.) are ignored.
  }
  return out;
}
