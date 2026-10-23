import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Container hardening (SEC-032).
 *
 * Asserted against the compose file rather than a running container so the
 * guarantee cannot silently regress: a hand-edit that drops `read_only` would
 * otherwise only be noticed by someone inspecting a live deployment.
 */
const compose = readFileSync('docker-compose.yml', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');

/** The three services running application code. */
const APP_SERVICES = ['api', 'worker', 'relay'];

const blockFor = (svc: string): string => {
  const i = compose.indexOf(`\n  ${svc}:`);
  expect(i, `service ${svc} is missing`).toBeGreaterThan(-1);
  const rest = compose.slice(i + 1);
  const next = rest.slice(3).search(/\n {2}[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 3);
};

describe('container hardening', () => {
  it('runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER (?!root|0)/m);
  });

  it('every application service has a READ-ONLY root filesystem', () => {
    // A compromised process cannot persist anything — no dropped binary, no
    // modified module, nothing that survives a restart.
    for (const s of APP_SERVICES) expect(blockFor(s), s).toMatch(/read_only:\s*true/);
  });

  it('every application service drops ALL capabilities', () => {
    // Nothing here needs one: no raw sockets, no binding below 1024, no mounts.
    for (const s of APP_SERVICES) expect(blockFor(s), s).toMatch(/cap_drop:\s*\["ALL"\]/);
  });

  it('every application service sets no-new-privileges', () => {
    // Without it a setuid binary in a base image remains an escalation path.
    for (const s of APP_SERVICES) {
      expect(blockFor(s), s).toMatch(/no-new-privileges:true/);
    }
  });

  it('provides a writable /tmp via tmpfs, since a read-only rootfs has none', () => {
    // Node needs a temp dir and xsltproc writes there while rendering; tmpfs
    // gives them one that is bounded and does not survive a restart.
    for (const s of APP_SERVICES) expect(blockFor(s), s).toMatch(/tmpfs:/);
  });

  it('bounds the tmpfs so it cannot be used to exhaust host memory', () => {
    for (const s of APP_SERVICES) expect(blockFor(s), s).toMatch(/size=\d+m/);
  });

  it('never mounts the docker socket into an application container', () => {
    // A mounted socket is root on the host, dressed as a volume.
    for (const s of APP_SERVICES) {
      expect(blockFor(s), s).not.toMatch(/docker\.sock/);
    }
  });

  it('declares no secret defaults — every one uses ${VAR:?}', () => {
    // A default password becomes the real production password of whoever
    // copies the file.
    const secrets = compose.match(/(PASSWORD|SECRET|KEY|TOKEN)[^\n]*/gi) ?? [];
    for (const line of secrets) {
      if (!line.includes('${')) continue;
      expect(line, line).toMatch(/:\?|:-\s*$|PASSO_PORT/);
    }
  });
});
