import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEV_CLI_PROVIDER_TOOLS } from './manifest';
import type { OfflineProductDatabase } from './offline-database';
import { CliError } from './protocol';
import { executeResourceOperation } from './resource-store';

interface WorkspaceCallStep {
  kind: 'workspace.call';
  tool: string;
  input?: Record<string, unknown>;
  expect?: { ok?: boolean };
}

interface ResourceStep {
  kind: 'workspace.resource';
  operation: 'list' | 'get' | 'create' | 'update' | 'delete';
  model: string;
  input?: Record<string, unknown>;
  expect?: { ok?: boolean };
}

type ScenarioStep = WorkspaceCallStep | ResourceStep;

interface ScenarioDocument {
  schemaVersion: 1;
  name: string;
  steps: ScenarioStep[];
}

function parseScenario(value: unknown): ScenarioDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError('SCENARIO_INVALID', 'Scenario must be a JSON object');
  const candidate = value as Partial<ScenarioDocument>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.name !== 'string' ||
    !Array.isArray(candidate.steps)
  ) {
    throw new CliError('SCENARIO_INVALID', 'Scenario requires schemaVersion=1, name and steps[]');
  }
  for (const [index, step] of candidate.steps.entries()) {
    if (
      !step ||
      typeof step !== 'object' ||
      !['workspace.call', 'workspace.resource'].includes((step as { kind?: string }).kind ?? '')
    ) {
      throw new CliError('SCENARIO_INVALID', `Step ${index + 1} has an unsupported kind`);
    }
  }
  return candidate as ScenarioDocument;
}

export async function loadScenario(file: string): Promise<ScenarioDocument> {
  const path = resolve(file.startsWith('@') ? file.slice(1) : file);
  try {
    return parseScenario(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'SCENARIO_INVALID',
      `Could not load scenario ${path}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function scenarioMutates(document: ScenarioDocument): boolean {
  return document.steps.some((step) =>
    step.kind === 'workspace.call'
      ? (DEV_CLI_PROVIDER_TOOLS.write as readonly string[]).includes(step.tool)
      : ['create', 'update', 'delete'].includes(step.operation),
  );
}

export async function runScenario(input: {
  document: ScenarioDocument;
  database: OfflineProductDatabase;
  projectId: string;
  requestId: string;
}): Promise<unknown> {
  const results: Array<{
    index: number;
    kind: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }> = [];
  for (const [index, step] of input.document.steps.entries()) {
    try {
      if (step.kind === 'workspace.call') {
        const { executeOfflineWorkspaceTool } = await import('./offline-workspace');
        const result = await executeOfflineWorkspaceTool({
          database: input.database.client,
          projectId: input.projectId,
          toolName: step.tool,
          arguments: step.input ?? {},
          requestId: `${input.requestId}-step-${index + 1}`,
        });
        const ok = result.result.ok;
        results.push({ index: index + 1, kind: step.kind, ok, result });
        if (step.expect?.ok !== undefined && step.expect.ok !== ok) {
          throw new CliError(
            'SCENARIO_ASSERTION_FAILED',
            `Step ${index + 1} expected ok=${step.expect.ok}, received ok=${ok}`,
            result,
          );
        }
        if (!ok) {
          throw new CliError('SCENARIO_STEP_FAILED', `Step ${index + 1} failed`, result);
        }
      } else {
        const result = executeResourceOperation({
          database: input.database.gateway.database,
          model: step.model,
          operation: step.operation,
          projectId: input.projectId,
          values: step.input ?? {},
        });
        results.push({ index: index + 1, kind: step.kind, ok: true, result });
        if (step.expect?.ok === false) {
          throw new CliError(
            'SCENARIO_ASSERTION_FAILED',
            `Step ${index + 1} expected ok=false, received ok=true`,
            result,
          );
        }
      }
    } catch (error) {
      results.push({
        index: index + 1,
        kind: step.kind,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CliError(
        'SCENARIO_FAILED',
        `Scenario "${input.document.name}" failed at step ${index + 1}`,
        { results },
      );
    }
  }
  return { name: input.document.name, steps: results.length, results };
}
