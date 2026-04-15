// src/core/run-store.ts
import * as fs from 'fs';
import * as path from 'path';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { Run } from '../types/runs.js';

export interface RunStore {
  load(): Run[];
  save(runs: Map<string, Run>): void;
}

const STALE_STAGES = new Set(['intake', 'speccing', 'implementing']);

interface FileRunStoreOptions {
  logDestination?: pino.DestinationStream;
}

export class FileRunStore implements RunStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  public demotedIds: Set<string> = new Set();

  constructor(workspaceRoot: string, options?: FileRunStoreOptions) {
    this.filePath = path.join(workspaceRoot, '.autocatalyst', 'runs.json');
    this.logger = createLogger('run-store', { destination: options?.logDestination });
  }

  load(): Run[] {
    this.demotedIds = new Set();

    // 1. File doesn't exist
    if (!fs.existsSync(this.filePath)) {
      this.logger.info({ event: 'run_store.loaded', total_loaded: 0, dropped_count: 0, demoted_count: 0 }, 'Run store loaded');
      return [];
    }

    // 2. Read + parse
    let raw: unknown;
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      this.logger.error({ event: 'run_store.load_failed', error: String(err) }, 'Failed to read or parse runs file');
      return [];
    }

    // 3. Must be an array
    if (!Array.isArray(raw)) {
      this.logger.error({ event: 'run_store.load_failed', error: 'Runs file is not an array' }, 'Runs file contains non-array JSON');
      return [];
    }

    const runs = raw as Run[];
    const kept: Run[] = [];
    let droppedCount = 0;
    let demotedCount = 0;

    for (const run of runs) {
      // 4. Drop runs with missing workspace
      if (!run.workspace_path || !fs.existsSync(run.workspace_path)) {
        this.logger.warn({ event: 'run_store.run_dropped', idea_id: run.idea_id, workspace_path: run.workspace_path }, 'Dropping run with missing workspace_path');
        droppedCount++;
        continue;
      }

      // 5. Demote stale stages
      if (STALE_STAGES.has(run.stage)) {
        const fromStage = run.stage;
        run.stage = 'failed';
        run.updated_at = new Date().toISOString();
        this.demotedIds.add(run.idea_id);
        demotedCount++;
        this.logger.info({ event: 'run_store.run_demoted', idea_id: run.idea_id, from_stage: fromStage, to_stage: 'failed' }, 'Demoted stale run to failed');
      }

      kept.push(run);
    }

    // 6. Log summary
    this.logger.info({ event: 'run_store.loaded', total_loaded: kept.length, dropped_count: droppedCount, demoted_count: demotedCount }, 'Run store loaded');

    return kept;
  }

  save(runs: Map<string, Run>): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...runs.values()], null, 2), 'utf-8');
      this.logger.debug({ event: 'run_store.saved', count: runs.size }, 'Run store saved');
    } catch (err) {
      this.logger.error({ event: 'run_store.save_failed', error: String(err) }, 'Failed to save runs file');
      // non-fatal — do not throw
    }
  }
}
