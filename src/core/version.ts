import pkg from '../../package.json';

export interface FormattedAppVersion {
  /** Compact `vx.y` badge shown beside the app logo (e.g. `v0.17`) */
  short: string;
  /** Full LogicFlow custom version string `vx.y-rz.w` (e.g. `v0.17-r0.0`) */
  full: string;
  /** Raw SemVer-compatible package.json version */
  raw: string;
}

/**
 * Convert SemVer-compatible `x.y.0-rz.w` (from package.json) into LogicFlow's
 * display formats: short `vx.y` for the brand header and full `vx.y-rz.w` for tooltips.
 */
export function formatAppVersion(rawVersion: string): FormattedAppVersion {
  const trimmed = rawVersion.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.\d+(?:-(r\d+\.\d+))?/);
  if (!match) {
    const clean = trimmed.startsWith('v') ? trimmed : `v${trimmed || '0.0'}`;
    return { short: clean, full: clean, raw: trimmed };
  }
  const short = `v${match[1]}.${match[2]}`;
  const full = match[3] ? `${short}-${match[3]}` : short;
  return { short, full, raw: trimmed };
}

export const APP_VERSION = formatAppVersion(pkg.version);
