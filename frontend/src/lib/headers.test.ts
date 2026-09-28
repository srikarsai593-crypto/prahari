import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The response headers are a security boundary, and a stale one is worse
 * than none.
 *
 * `Permissions-Policy` listed `camera=()` — correct when it was written,
 * and wrong from the moment the QR scanner shipped. It disabled the camera
 * for the whole origin in every browser, so the cargo page's webcam scan
 * and field mode's "Scan cargo" both failed with what looks like a broken
 * camera rather than a broken header. Nothing caught it because nothing
 * tied the policy to the features that depend on it.
 *
 * This does. It reads the config and the source together: if a feature
 * needs a permission, the policy has to grant it, and if nothing needs one
 * it stays denied.
 */

const root = join(__dirname, '..', '..');
const config = readFileSync(join(root, 'next.config.ts'), 'utf8');

const policy = (() => {
  const line = config.split('\n').find((l) => l.includes("value: 'geolocation="));
  if (!line) throw new Error('Permissions-Policy value not found in next.config.ts');
  return line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
})();

const directive = (name: string): string | null => {
  const m = policy.match(new RegExp(`${name}=\\(([^)]*)\\)`));
  return m ? m[1].trim() : null;
};

describe('Permissions-Policy', () => {
  it('grants the camera to this origin, because the scanner needs it', () => {
    expect(directive('camera'), `policy is: ${policy}`).toBe('self');
  });

  it('denies everything the console does not use', () => {
    // Geolocation is denied on purpose: field mode reports the station's
    // last known position for an SOS rather than prompting for the
    // handset's own, so a refused prompt can never blank the field.
    for (const name of ['geolocation', 'microphone', 'payment', 'usb']) {
      expect(directive(name), `${name} should be denied; policy is: ${policy}`).toBe('');
    }
  });
});

describe('the policy matches what the code actually asks for', () => {
  const sources = ['src/app/cargo/page.tsx', 'src/app/field/page.tsx']
    .map((f) => readFileSync(join(root, f), 'utf8')).join('\n');

  it('the camera really is used, so the grant is not over-broad', () => {
    expect(sources).toMatch(/facingMode|Html5Qrcode/);
  });

  it('nothing reaches for a permission the policy denies', () => {
    // Test files are excluded: this one names those APIs in its own prose
    // and matched itself the first time it ran.
    const hits = execSync(
      'grep -rl "navigator\\.geolocation\\|SpeechRecognition\\|MediaRecorder" '
      + 'src/app src/components src/lib || true',
      { cwd: root, encoding: 'utf8' },
    ).split('\n').map((f) => f.trim())
      .filter((f) => f && !f.includes('.test.'));
    expect(hits, `these reach for a permission the policy denies:\n${hits.join('\n')}`)
      .toEqual([]);
  });
});
