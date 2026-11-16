/**
 * The built PasaBot Screen Helper (macOS only; needs the Command Line Tools). Security review, 2026-11-15:
 * - it is always signed with the hardened runtime, ad-hoc too, so DYLD_INSERT_LIBRARIES never loads code into the
 *   process that holds Screen Recording and Accessibility (an unhardened ad-hoc copy of the same binary does load it);
 * - its `--selftest` passes: the grant vector and refusals, the per-step re-checks of type/key, the protected
 *   PasaBot windows, and the one trusted data folder (~/.pasabot, never another `--home`, never a symlink).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const has = (cmd: string) => spawnSync('/usr/bin/which', [cmd]).status === 0;
const canBuild = process.platform === 'darwin' && has('swiftc') && has('cc') && has('codesign');
const script = fileURLToPath(new URL('../macos/build-screen-helper.sh', import.meta.url));

describe.runIf(canBuild)('PasaBot Screen Helper build (macOS)', () => {
  const out = mkdtempSync(join(tmpdir(), 'pb-helper-build-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'PasaBot Screen Helper.app', 'Contents', 'MacOS', 'PasaBotScreenHelper');

  it('is signed with the hardened runtime and passes its selftest', () => {
    const log = execFileSync(script, ['--out', out, '--selftest'], { encoding: 'utf8', timeout: 240_000 });
    expect(log).toMatch(/selftest: \d+ passed, 0 failed/);
    const info = spawnSync('codesign', ['-d', '--verbose=2', join(out, 'PasaBot Screen Helper.app')], {
      encoding: 'utf8',
    });
    expect(`${info.stdout}${info.stderr}`).toMatch(/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/);
  }, 300_000);

  it('ignores DYLD_INSERT_LIBRARIES (an unhardened copy of the same binary would load the library)', () => {
    const src = join(out, 'inj.c');
    const lib = join(out, 'inj.dylib');
    writeFileSync(
      src,
      '#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void hit(void) { const char *p = getenv("PB_MARK"); if (p) { FILE *f = fopen(p, "w"); if (f) { fputs("x", f); fclose(f); } } }\n',
    );
    execFileSync('cc', ['-dynamiclib', '-o', lib, src]);
    const run = (exe: string, mark: string) =>
      spawnSync(exe, ['--version'], {
        env: { PATH: process.env.PATH ?? '', PB_MARK: mark, DYLD_INSERT_LIBRARIES: lib },
        encoding: 'utf8',
        timeout: 10_000,
      });
    const hardened = join(out, 'hardened.mark');
    expect(run(bin, hardened).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(hardened)).toBe(false);
    // the control: the same binary signed the old way (ad-hoc, no runtime) does load it
    const plain = join(out, 'plain');
    copyFileSync(bin, plain);
    execFileSync('codesign', ['--force', '--sign', '-', plain], { stdio: 'ignore' });
    const loaded = join(out, 'plain.mark');
    run(plain, loaded);
    expect(existsSync(loaded)).toBe(true);
  }, 60_000);

  it('refuses entitlements that would switch library validation or dyld variables back on', () => {
    const ent = join(out, 'bad.entitlements');
    writeFileSync(
      ent,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
    );
    const r = spawnSync(script, ['--out', join(out, 'bad')], {
      env: { ...process.env, SCREEN_HELPER_ENTITLEMENTS: ent },
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/disable-library-validation/);
  }, 300_000);
});
