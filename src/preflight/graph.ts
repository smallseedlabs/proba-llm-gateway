/**
 * Small typed prerequisite graph inside the gateway. This is not a mesh,
 * registry, or separate service. Operation manifests declare dependencies;
 * evaluation is deterministic (cheap local first) and fail-closed.
 *
 * LLM/user/tool text cannot add, remove, or relax nodes.
 */

import { ConfigError } from '../errors.js';
import { AD_PLATFORMS, type AdPlatform } from '../types/limbs.js';
import type {
  OperationIntent,
  OperationManifest,
  PrerequisiteId,
  RunPhase,
  SpendClass,
} from '../types/preflight.js';

export class GraphDefinitionError extends ConfigError {
  readonly graphCode = 'prerequisite_graph_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'GraphDefinitionError';
  }
}

export interface PrerequisiteNode {
  id: PrerequisiteId;
  /** 0 = cheapest local. Higher costs are remote/bundled adapter probes. */
  cost: 0 | 1 | 2 | 3;
  kind: 'local' | 'remote';
  dependsOn: readonly PrerequisiteId[];
}

export const PREREQUISITE_NODES: Record<PrerequisiteId, PrerequisiteNode> = {
  intent: { id: 'intent', cost: 0, kind: 'local', dependsOn: [] },
  'auth.workspace': { id: 'auth.workspace', cost: 0, kind: 'local', dependsOn: [] },
  'run.budget': { id: 'run.budget', cost: 0, kind: 'local', dependsOn: [] },
  'limb.manifest': { id: 'limb.manifest', cost: 0, kind: 'local', dependsOn: [] },
  'ads.service': { id: 'ads.service', cost: 1, kind: 'remote', dependsOn: [] },
  'llm.quota': { id: 'llm.quota', cost: 1, kind: 'remote', dependsOn: [] },
  'ads.connection': { id: 'ads.connection', cost: 2, kind: 'remote', dependsOn: ['ads.service'] },
  'ads.permissions': { id: 'ads.permissions', cost: 2, kind: 'remote', dependsOn: ['ads.service', 'ads.connection'] },
  'ads.blueprint': { id: 'ads.blueprint', cost: 2, kind: 'remote', dependsOn: ['ads.service'] },
  'ads.billing': { id: 'ads.billing', cost: 3, kind: 'remote', dependsOn: ['ads.service', 'ads.connection'] },
};

const KNOWN_IDS = new Set(Object.keys(PREREQUISITE_NODES) as PrerequisiteId[]);

/** Verbs that increase ad spend. Locked policy requires billing immediately before these. */
const SPEND_INCREASE_VERBS = new Set(['ads.create_campaign', 'ads.resume_campaign', 'create_campaign', 'resume_campaign']);
const SAFETY_DECREASE_VERBS = new Set(['ads.pause_campaign', 'pause_campaign']);

export function spendClassForVerb(verb: string | undefined, args?: Record<string, unknown>): SpendClass {
  if (!verb) return 'none';
  const name = verb.startsWith('ads.') ? verb : `ads.${verb}`;
  if (SAFETY_DECREASE_VERBS.has(verb) || SAFETY_DECREASE_VERBS.has(name)) return 'safety_decrease';
  if (SPEND_INCREASE_VERBS.has(verb) || SPEND_INCREASE_VERBS.has(name)) return 'spend_increase';
  if (name === 'ads.update_campaign' || verb === 'update_campaign') {
    return typeof args?.dailyBudget === 'number' ? 'spend_increase' : 'none';
  }
  if (name.startsWith('ads.')) return 'spend_increase';
  return 'none';
}

export function asAdPlatform(value: unknown): AdPlatform | undefined {
  return typeof value === 'string' && (AD_PLATFORMS as readonly string[]).includes(value)
    ? (value as AdPlatform)
    : undefined;
}

export function operationManifest(input: {
  phase: RunPhase;
  intent: OperationIntent;
}): OperationManifest {
  const { phase, intent } = input;
  const spendClass = intent.spendClass;
  const requires: PrerequisiteId[] = ['intent', 'auth.workspace', 'run.budget'];
  if (phase === 'brain') requires.push('llm.quota');

  if (intent.kind === 'insufficient_intent') {
    return { id: `${phase}:insufficient_intent`, phase, spendClass, requires: Object.freeze(requires) };
  }

  if (intent.kind === 'page_mutate' || (intent.kind === 'read_or_plan' && intent.requiresPage) || (intent.kind === 'ads_mutate' && intent.requiresPage)) {
    requires.push('limb.manifest');
  }

  if (intent.kind === 'ads_mutate') {
    requires.push('limb.manifest', 'ads.service', 'ads.connection', 'ads.permissions');
    if (intent.mappingRequired) requires.push('ads.blueprint');
    if (spendClass === 'spend_increase') requires.push('ads.billing');
  }

  const unique = [...new Set(requires)];
  const verb = intent.kind === 'ads_mutate' ? intent.verb ?? 'ads' : intent.kind === 'page_mutate' ? 'page' : 'read';
  return { id: `${phase}:${verb}`, phase, spendClass, requires: Object.freeze(unique) };
}

/**
 * Kahn topological order with a deterministic tie-break: lower cost first,
 * then prerequisite id. Throws on cycles and unknown/unclosed dependency defs.
 */
export function orderPrerequisites(
  required: readonly PrerequisiteId[],
  nodes: Record<string, { cost: number; dependsOn: readonly string[] }> = PREREQUISITE_NODES
): PrerequisiteId[] {
  assertClosedRequires(required, nodes);
  const requiredSet = new Set<string>(required);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of required) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const id of required) {
    const node = nodes[id];
    if (!node) throw new GraphDefinitionError(`unknown prerequisite ${id}`);
    for (const dep of node.dependsOn) {
      if (!requiredSet.has(dep)) {
        throw new GraphDefinitionError(`prerequisite ${id} depends on ${dep} which is not in the operation manifest`);
      }
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      outgoing.get(dep)?.push(id);
    }
  }

  const ready = [...required.filter((id) => (indegree.get(id) ?? 0) === 0)] as string[];
  ready.sort(byCostThenId(nodes));
  const ordered: PrerequisiteId[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) break;
    ordered.push(next as PrerequisiteId);
    for (const child of outgoing.get(next) ?? []) {
      const nextDegree = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, nextDegree);
      if (nextDegree === 0) {
        ready.push(child);
        ready.sort(byCostThenId(nodes));
      }
    }
  }
  if (ordered.length !== required.length) {
    const leftover = required.filter((id) => !ordered.includes(id));
    throw new GraphDefinitionError(`prerequisite graph cycle involving ${leftover.join(',')}`);
  }
  return ordered;
}

export function assertGraphSound(
  nodes: Record<string, { cost: number; dependsOn: readonly string[] }> = PREREQUISITE_NODES,
  manifests: readonly OperationManifest[] = SOUNDNESS_MANIFESTS
): void {
  const ids = Object.keys(nodes);
  for (const id of ids) {
    const node = nodes[id];
    if (!node) throw new GraphDefinitionError(`missing node ${id}`);
    for (const dep of node.dependsOn) {
      if (!(dep in nodes)) throw new GraphDefinitionError(`node ${id} depends on unknown ${dep}`);
      if (dep === id) throw new GraphDefinitionError(`node ${id} depends on itself`);
    }
  }
  orderPrerequisites(ids as PrerequisiteId[], nodes);
  for (const manifest of manifests) {
    for (const id of manifest.requires) {
      if (!(id in nodes)) throw new GraphDefinitionError(`manifest ${manifest.id} requires unknown ${id}`);
    }
    orderPrerequisites(manifest.requires, nodes);
    if (manifest.requires.includes('run.budget') === false) {
      throw new GraphDefinitionError(`manifest ${manifest.id} must not omit run.budget`);
    }
    if (manifest.requires.includes('auth.workspace') === false) {
      throw new GraphDefinitionError(`manifest ${manifest.id} must not omit auth.workspace`);
    }
  }
}

function assertClosedRequires(
  required: readonly string[],
  nodes: Record<string, { dependsOn: readonly string[] }>
): void {
  const set = new Set(required);
  for (const id of required) {
    if (!(id in nodes) && !KNOWN_IDS.has(id as PrerequisiteId)) {
      throw new GraphDefinitionError(`unknown prerequisite ${id}`);
    }
    const node = nodes[id];
    if (!node) throw new GraphDefinitionError(`unknown prerequisite ${id}`);
    for (const dep of node.dependsOn) {
      if (!set.has(dep)) {
        throw new GraphDefinitionError(`prerequisite ${id} depends on ${dep} which is not in the operation manifest`);
      }
    }
  }
}

function byCostThenId(nodes: Record<string, { cost: number }>): (a: string, b: string) => number {
  return (a, b) => {
    const cost = (nodes[a]?.cost ?? 99) - (nodes[b]?.cost ?? 99);
    return cost !== 0 ? cost : a.localeCompare(b);
  };
}

const SOUNDNESS_MANIFESTS: readonly OperationManifest[] = [
  operationManifest({
    phase: 'brain',
    intent: { kind: 'read_or_plan', requiresAds: false, requiresPage: false, spendClass: 'none' },
  }),
  operationManifest({
    phase: 'brain',
    intent: {
      kind: 'ads_mutate',
      requiresAds: true,
      requiresPage: false,
      verb: 'ads.create_campaign',
      mappingRequired: false,
      spendClass: 'spend_increase',
    },
  }),
  operationManifest({
    phase: 'mutate',
    intent: {
      kind: 'ads_mutate',
      requiresAds: true,
      requiresPage: false,
      verb: 'ads.pause_campaign',
      mappingRequired: true,
      spendClass: 'safety_decrease',
    },
  }),
  operationManifest({
    phase: 'mutate',
    intent: {
      kind: 'ads_mutate',
      requiresAds: true,
      requiresPage: false,
      verb: 'ads.resume_campaign',
      mappingRequired: true,
      spendClass: 'spend_increase',
    },
  }),
];

assertGraphSound();

export const BILLING_RELAXED_REASON =
  'policy: ad-account balance does not block analysis/reporting/pausing or other non-spend-increasing safety actions; account exists/running is not authorization';
