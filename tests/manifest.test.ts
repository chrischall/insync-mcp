import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readToolRoster } from './_tools.js';

const manifestTools = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8')) as {
    tools: { name: string; description: string }[];
  }
).tools;

describe('manifest.json tools', () => {
  // Both directions: a tool registered but absent from manifest.json is callable
  // by name yet invisible to an mcpb host; one listed but unregistered promises
  // a tool the server does not serve. `insync_healthcheck` is registered by the
  // index alongside the read modules, so it belongs in the manifest too.
  it('equals the registered roster in both directions', () => {
    const registered = new Set([...readToolRoster(), 'insync_healthcheck']);
    const listed = new Set(manifestTools.map((t) => t.name));
    expect([...registered].filter((n) => !listed.has(n)), 'registered but not in manifest').toEqual([]);
    expect([...listed].filter((n) => !registered.has(n)), 'in manifest but not registered').toEqual([]);
  });

  it('gives every tool a non-blank description', () => {
    for (const t of manifestTools) {
      expect(t.description?.trim().length, `${t.name} has no description`).toBeGreaterThan(10);
    }
  });
});
