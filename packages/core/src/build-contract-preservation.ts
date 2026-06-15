import ts from 'typescript';
import type { AltitudeCheckpointRef, ConvergenceRoundFinding } from '@autocatalyst/api-contract';

export interface ExtractedContractEntry {
  readonly sourcePath: string;
  readonly symbolName: string;
  readonly exportScope: 'public' | 'private';
  readonly kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'variable';
  readonly canonicalSignature: string;
}

export interface ExtractedContract {
  readonly sourcePath: string;
  readonly entries: readonly ExtractedContractEntry[];
}

export interface ValidateBuildContractInput {
  readonly workspaceRepoRoot: string;
  readonly buildCommitSha: string;
  readonly acceptedCheckpoints: readonly AltitudeCheckpointRef[];
  readonly readFileAtRef: (input: { ref: string; path: string }) => Promise<string | null>;
  readonly listFilesAtRef: (input: { ref: string }) => Promise<readonly string[]>;
}

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

function isTypeScriptSource(path: string): boolean {
  const ext = getExtension(path);
  return ext === '.ts' || ext === '.tsx' || normalizePath(path).endsWith('.d.ts');
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function printSignatureWithoutBody(node: ts.Node, sourceFile: ts.SourceFile): string {
  let toPrint: ts.Node = node;
  if (ts.isFunctionDeclaration(node)) {
    toPrint = ts.factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      undefined
    );
  } else if (ts.isClassDeclaration(node)) {
    const newMembers = node.members.map((member) => stripMemberBody(member));
    toPrint = ts.factory.updateClassDeclaration(
      node,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.heritageClauses,
      newMembers
    );
  }
  try {
    return normalizeWhitespace(printer.printNode(ts.EmitHint.Unspecified, toPrint, sourceFile));
  } catch {
    return normalizeWhitespace(node.getText(sourceFile));
  }
}

function stripMemberBody(member: ts.ClassElement): ts.ClassElement {
  if (ts.isMethodDeclaration(member)) {
    return ts.factory.updateMethodDeclaration(
      member,
      member.modifiers,
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters,
      member.type,
      undefined
    );
  }
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      member.modifiers,
      member.parameters,
      undefined
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      member.type,
      undefined
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      undefined
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    return ts.factory.updatePropertyDeclaration(
      member,
      member.modifiers,
      member.name,
      member.questionToken ?? member.exclamationToken,
      member.type,
      undefined
    );
  }
  return member;
}

function tryParse(sourcePath: string, source: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  } catch {
    return null;
  }
}

function extractEntries(
  sourcePath: string,
  sourceFile: ts.SourceFile,
  scope: 'public' | 'private'
): ExtractedContractEntry[] {
  const entries: ExtractedContractEntry[] = [];
  const wantExport = scope === 'public';

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (!stmt.name) continue;
      const isExported = hasExportModifier(stmt);
      if (isExported !== wantExport) continue;
      entries.push({
        sourcePath,
        symbolName: stmt.name.text,
        exportScope: scope,
        kind: 'function',
        canonicalSignature: printSignatureWithoutBody(stmt, sourceFile)
      });
    } else if (ts.isClassDeclaration(stmt)) {
      if (!stmt.name) continue;
      const isExported = hasExportModifier(stmt);
      if (isExported !== wantExport) continue;
      entries.push({
        sourcePath,
        symbolName: stmt.name.text,
        exportScope: scope,
        kind: 'class',
        canonicalSignature: printSignatureWithoutBody(stmt, sourceFile)
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      // Interfaces are type-only; only check exported (public scope).
      if (scope !== 'public') continue;
      if (!hasExportModifier(stmt)) continue;
      entries.push({
        sourcePath,
        symbolName: stmt.name.text,
        exportScope: 'public',
        kind: 'interface',
        canonicalSignature: normalizeWhitespace(stmt.getText(sourceFile))
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      if (scope !== 'public') continue;
      if (!hasExportModifier(stmt)) continue;
      entries.push({
        sourcePath,
        symbolName: stmt.name.text,
        exportScope: 'public',
        kind: 'type',
        canonicalSignature: normalizeWhitespace(stmt.getText(sourceFile))
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      if (scope !== 'public') continue;
      if (!hasExportModifier(stmt)) continue;
      entries.push({
        sourcePath,
        symbolName: stmt.name.text,
        exportScope: 'public',
        kind: 'enum',
        canonicalSignature: normalizeWhitespace(stmt.getText(sourceFile))
      });
    } else if (ts.isVariableStatement(stmt)) {
      if (scope !== 'public') continue;
      if (!hasExportModifier(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
        // Canonical: name + type annotation (strip initializer).
        const typeText = decl.type ? `: ${decl.type.getText(sourceFile)}` : '';
        const sig = `export ${isConst ? 'const' : 'let'} ${decl.name.text}${typeText};`;
        entries.push({
          sourcePath,
          symbolName: decl.name.text,
          exportScope: 'public',
          kind: isConst ? 'constant' : 'variable',
          canonicalSignature: normalizeWhitespace(sig)
        });
      }
    }
  }

  return entries;
}

export function extractPublicContracts(
  sourcePath: string,
  source: string
): ExtractedContractEntry[] {
  const sourceFile = tryParse(sourcePath, source);
  if (!sourceFile) return [];
  return extractEntries(sourcePath, sourceFile, 'public');
}

export function extractPrivateContracts(
  sourcePath: string,
  source: string
): ExtractedContractEntry[] {
  const sourceFile = tryParse(sourcePath, source);
  if (!sourceFile) return [];
  return extractEntries(sourcePath, sourceFile, 'private');
}

export function canonicalizeSignature(text: string): string {
  return normalizeWhitespace(text);
}

function makeFinding(args: {
  checkpointAltitude: 'layout' | 'public_api' | 'private_api';
  sourcePath: string;
  ruleId: string;
  symbolName: string | null;
  title: string;
  body: string;
  acceptedCheckpoint: AltitudeCheckpointRef;
}): ConvergenceRoundFinding {
  const norm = normalizePath(args.sourcePath);
  const key = `build_drift:${args.checkpointAltitude}:${norm}:${args.ruleId}:${
    args.symbolName ?? 'file'
  }`;
  const finding: ConvergenceRoundFinding = {
    feedbackId: key,
    title: args.title,
    body: args.body,
    severity: 'blocker',
    source: 'build_drift',
    category: 'build_drift',
    altitude: 'build',
    blocking: true,
    signature: key,
    blockingReason: `Build altitude drifted from accepted ${args.checkpointAltitude} checkpoint`,
    deterministicKey: key,
    sourcePath: norm,
    acceptedCheckpoint: {
      altitude: args.acceptedCheckpoint.altitude,
      ref: args.acceptedCheckpoint.ref,
      commitSha: args.acceptedCheckpoint.commitSha
    },
    ...(args.symbolName ? { symbolName: args.symbolName } : {})
  };
  return finding;
}

function parseFailureFinding(args: {
  checkpointAltitude: 'layout' | 'public_api' | 'private_api';
  sourcePath: string;
  side: 'checkpoint' | 'build';
  acceptedCheckpoint: AltitudeCheckpointRef;
}): ConvergenceRoundFinding {
  return makeFinding({
    checkpointAltitude: args.checkpointAltitude,
    sourcePath: args.sourcePath,
    ruleId: `parse_failure_${args.side}`,
    symbolName: null,
    title: 'Build contract drift: parse failure',
    body: `Could not parse ${normalizePath(args.sourcePath)} at the ${args.side} ref while validating accepted ${args.checkpointAltitude} checkpoint; resolve syntax errors so the contract can be verified.`,
    acceptedCheckpoint: args.acceptedCheckpoint
  });
}

async function compareFileAgainstCheckpoint(
  args: {
    sourcePath: string;
    checkpoint: AltitudeCheckpointRef;
    checkpointSource: string;
    buildSource: string;
    checkPrivate: boolean;
  }
): Promise<ConvergenceRoundFinding[]> {
  const { sourcePath, checkpoint, checkpointSource, buildSource } = args;
  const findings: ConvergenceRoundFinding[] = [];
  const altitude = checkpoint.altitude;

  const checkpointParsed = tryParse(sourcePath, checkpointSource);
  if (!checkpointParsed) {
    findings.push(
      parseFailureFinding({
        checkpointAltitude: altitude,
        sourcePath,
        side: 'checkpoint',
        acceptedCheckpoint: checkpoint
      })
    );
    return findings;
  }
  const buildParsed = tryParse(sourcePath, buildSource);
  if (!buildParsed) {
    findings.push(
      parseFailureFinding({
        checkpointAltitude: altitude,
        sourcePath,
        side: 'build',
        acceptedCheckpoint: checkpoint
      })
    );
    return findings;
  }

  // Public exports — checked for public_api and layout checkpoints (layout cares about types/interfaces).
  if (altitude === 'public_api' || altitude === 'layout') {
    const checkpointPublic = extractEntries(sourcePath, checkpointParsed, 'public');
    const buildPublic = extractEntries(sourcePath, buildParsed, 'public');
    const buildByName = new Map(buildPublic.map((e) => [e.symbolName, e] as const));

    for (const entry of checkpointPublic) {
      const buildEntry = buildByName.get(entry.symbolName);
      if (!buildEntry) {
        findings.push(
          makeFinding({
            checkpointAltitude: altitude,
            sourcePath,
            ruleId: 'export_removed',
            symbolName: entry.symbolName,
            title: 'Build contract drift: public export removed',
            body: `Public export '${entry.symbolName}' in ${normalizePath(sourcePath)} was accepted at the ${altitude} checkpoint but is missing at the build ref.`,
            acceptedCheckpoint: checkpoint
          })
        );
        continue;
      }
      if (
        !signaturesCompatible(
          entry.canonicalSignature,
          buildEntry.canonicalSignature,
          entry.kind
        )
      ) {
        findings.push(
          makeFinding({
            checkpointAltitude: altitude,
            sourcePath,
            ruleId: 'export_signature_changed',
            symbolName: entry.symbolName,
            title: 'Build contract drift: public export signature changed',
            body: `Public export '${entry.symbolName}' in ${normalizePath(sourcePath)} drifted from the accepted ${altitude} signature.\nAccepted: ${entry.canonicalSignature}\nBuild: ${buildEntry.canonicalSignature}`,
            acceptedCheckpoint: checkpoint
          })
        );
      }
    }
  }

  // Private helpers — only when a private_api checkpoint is being checked.
  if (args.checkPrivate && altitude === 'private_api') {
    const checkpointPrivate = extractEntries(sourcePath, checkpointParsed, 'private');
    const buildPrivate = extractEntries(sourcePath, buildParsed, 'private');
    const buildByName = new Map(buildPrivate.map((e) => [e.symbolName, e] as const));

    for (const entry of checkpointPrivate) {
      const buildEntry = buildByName.get(entry.symbolName);
      if (!buildEntry) {
        // A removed private helper isn't a contract break by itself — the public
        // surface is what matters. Skip.
        continue;
      }
      if (
        !signaturesCompatible(
          entry.canonicalSignature,
          buildEntry.canonicalSignature,
          entry.kind
        )
      ) {
        findings.push(
          makeFinding({
            checkpointAltitude: altitude,
            sourcePath,
            ruleId: 'private_signature_changed',
            symbolName: entry.symbolName,
            title: 'Build contract drift: private helper signature changed',
            body: `Private helper '${entry.symbolName}' in ${normalizePath(sourcePath)} drifted from the accepted ${altitude} signature.\nAccepted: ${entry.canonicalSignature}\nBuild: ${buildEntry.canonicalSignature}`,
            acceptedCheckpoint: checkpoint
          })
        );
      }
    }
  }

  return findings;
}

/**
 * Signatures are compatible if their canonical forms match after stripping
 * `declare` keywords (a declared signature may gain an implementation body —
 * the printer already drops the body — without that being a contract change).
 */
function signaturesCompatible(
  accepted: string,
  build: string,
  _kind: ExtractedContractEntry['kind']
): boolean {
  const strip = (s: string): string =>
    s
      .replace(/\bdeclare\s+/g, '')
      .replace(/;+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return strip(accepted) === strip(build);
}

export async function validateBuildContractPreservation(
  input: ValidateBuildContractInput
): Promise<ConvergenceRoundFinding[]> {
  if (input.acceptedCheckpoints.length === 0) return [];

  const buildFiles = new Set(
    (await input.listFilesAtRef({ ref: input.buildCommitSha })).map(normalizePath)
  );

  const findings: ConvergenceRoundFinding[] = [];
  const hasPrivateCheckpoint = input.acceptedCheckpoints.some(
    (c) => c.altitude === 'private_api'
  );

  // Sort checkpoints by altitude for deterministic output ordering.
  const altitudeOrder: Record<AltitudeCheckpointRef['altitude'], number> = {
    layout: 0,
    public_api: 1,
    private_api: 2
  };
  const sortedCheckpoints = [...input.acceptedCheckpoints].sort(
    (a, b) => altitudeOrder[a.altitude] - altitudeOrder[b.altitude]
  );

  for (const checkpoint of sortedCheckpoints) {
    const checkpointFiles = (await input.listFilesAtRef({ ref: checkpoint.ref }))
      .map(normalizePath)
      .filter(isTypeScriptSource)
      .slice()
      .sort();

    for (const sourcePath of checkpointFiles) {
      // 1) File missing at build → source_path_removed.
      if (!buildFiles.has(sourcePath)) {
        findings.push(
          makeFinding({
            checkpointAltitude: checkpoint.altitude,
            sourcePath,
            ruleId: 'source_path_removed',
            symbolName: null,
            title: 'Build contract drift: accepted source path missing',
            body: `Source file ${sourcePath} existed at the accepted ${checkpoint.altitude} checkpoint but is missing at the build ref. Accepted source paths are immutable at the build altitude.`,
            acceptedCheckpoint: checkpoint
          })
        );
        continue;
      }

      const checkpointSource = await input.readFileAtRef({
        ref: checkpoint.ref,
        path: sourcePath
      });
      const buildSource = await input.readFileAtRef({
        ref: input.buildCommitSha,
        path: sourcePath
      });

      if (checkpointSource === null) continue; // listed but unreadable — skip.
      if (buildSource === null) {
        findings.push(
          makeFinding({
            checkpointAltitude: checkpoint.altitude,
            sourcePath,
            ruleId: 'source_path_removed',
            symbolName: null,
            title: 'Build contract drift: accepted source path missing',
            body: `Source file ${sourcePath} existed at the accepted ${checkpoint.altitude} checkpoint but could not be read at the build ref.`,
            acceptedCheckpoint: checkpoint
          })
        );
        continue;
      }

      const fileFindings = await compareFileAgainstCheckpoint({
        sourcePath,
        checkpoint,
        checkpointSource,
        buildSource,
        checkPrivate: hasPrivateCheckpoint
      });
      findings.push(...fileFindings);
    }
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
