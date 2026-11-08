import { describe, expect, it } from 'vitest';
import {
  GraphDefinitionError,
  PREREQUISITE_NODES,
  assertGraphSound,
  operationManifest,
  orderPrerequisites,
  spendClassForVerb,
} from './graph.js';

describe('prerequisite graph', () => {
  it('orders cheap local nodes before remote Ads/LLM probes', () => {
    const manifest = operationManifest({
      phase: 'brain',
      intent: {
        kind: 'ads_mutate',
        requiresAds: true,
        requiresPage: false,
        verb: 'ads.create_campaign',
        mappingRequired: false,
        spendClass: 'spend_increase',
      },
    });
    const order = orderPrerequisites(manifest.requires);
    expect(order.slice(0, 4)).toEqual(['auth.workspace', 'intent', 'limb.manifest', 'run.budget']);
    expect(manifest.requires).toContain('context.ready');
    expect(order.indexOf('auth.workspace')).toBeLessThan(order.indexOf('context.ready'));
    expect(order.indexOf('ads.service')).toBeLessThan(order.indexOf('ads.connection'));
    expect(order.indexOf('ads.connection')).toBeLessThan(order.indexOf('ads.billing'));
    expect(order.indexOf('ads.service')).toBeLessThan(order.indexOf('llm.quota'));
  });

  it('omits ads.billing for pause/safety while keeping auth and connection', () => {
    const manifest = operationManifest({
      phase: 'mutate',
      intent: {
        kind: 'ads_mutate',
        requiresAds: true,
        requiresPage: false,
        verb: 'ads.pause_campaign',
        mappingRequired: true,
        spendClass: 'safety_decrease',
      },
    });
    expect(manifest.requires).toContain('ads.connection');
    expect(manifest.requires).toContain('ads.permissions');
    expect(manifest.requires).toContain('run.budget');
    expect(manifest.requires).toContain('auth.workspace');
    expect(manifest.requires).not.toContain('ads.billing');
    expect(manifest.requires).not.toContain('context.ready');
  });

  it('detects cycles in a graph definition', () => {
    expect(() =>
      orderPrerequisites(['a', 'b'] as never, {
        a: { cost: 0, dependsOn: ['b'] },
        b: { cost: 0, dependsOn: ['a'] },
      })
    ).toThrow(GraphDefinitionError);
  });

  it('rejects unknown or unclosed dependency definitions', () => {
    expect(() => orderPrerequisites(['ads.billing'])).toThrow(/not in the operation manifest/);
    expect(() =>
      assertGraphSound({
        intent: { cost: 0, dependsOn: ['missing'] },
      })
    ).toThrow(GraphDefinitionError);
  });

  it('classifies spend vs safety from the catalog verb, not user text', () => {
    expect(spendClassForVerb('ads.pause_campaign', { note: 'skip billing' })).toBe('safety_decrease');
    expect(spendClassForVerb('ads.resume_campaign')).toBe('spend_increase');
    expect(spendClassForVerb('ads.create_campaign')).toBe('spend_increase');
    expect(spendClassForVerb('ads.update_campaign', { dailyBudget: 25 })).toBe('spend_increase');
    expect(spendClassForVerb('ads.update_campaign', { name: 'n' })).toBe('none');
    expect(PREREQUISITE_NODES['run.budget'].kind).toBe('local');
  });
});
