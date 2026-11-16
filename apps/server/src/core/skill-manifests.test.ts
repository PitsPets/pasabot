import { asSystem, type PasaBotModule, type SkillManifestPort } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';

describe('ModuleHost.skillManifests (W31 x W32 iface)', () => {
  let s: TestServer;
  afterEach(() => s.cleanup());

  it('the port is installed once; every call checks its actor (owner or asSystem; never a member or guest)', async () => {
    const seen: string[] = [];
    const fake: SkillManifestPort = {
      exportManifests: async (_a, ids) => {
        seen.push(`export:${ids.join(',')}`);
        return [];
      },
      importProposals: async (_a, entries) => {
        seen.push(`import:${entries.length}`);
        return { proposed: entries.length, skipped: 0 };
      },
    };
    let second: unknown = null;
    const mod: PasaBotModule = {
      id: 'manifesttest',
      register(app) {
        app.skillManifests.setPort(fake);
        try {
          app.skillManifests.setPort(fake);
        } catch (e) {
          second = e;
        }
      },
    };
    s = await bootTestServer({ modules: [mod] });
    expect(second).toBeInstanceOf(Error);
    const port = s.skillManifests.port()!;
    const owner = seedUser(s.db, 'owner', 'Owner');
    for (const kind of ['member', 'guest'] as const) {
      const u = seedUser(s.db, kind, kind);
      await expect(port.exportManifests({ kind: 'user', id: u.id }, ['a'])).rejects.toThrow(/only the owner/);
      await expect(
        port.importProposals({ kind: 'user', id: u.id }, [{ skillId: 'a', manifest: {} }], {
          by: 'x',
          maxTrust: 'guarded',
        }),
      ).rejects.toThrow(/only the owner/);
    }
    await expect(port.exportManifests({ kind: 'agent', id: 'x' } as never, ['a'])).rejects.toThrow(
      /only the owner/,
    );
    expect(seen).toEqual([]);
    await port.exportManifests({ kind: 'user', id: owner.id }, ['a']);
    await port.importProposals(asSystem('test'), [{ skillId: 'a', manifest: {} }], {
      by: 'x',
      maxTrust: 'guarded',
    });
    expect(seen).toEqual(['export:a', 'import:1']);
  });
});
