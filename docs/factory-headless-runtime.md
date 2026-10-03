# Factory headless runtime extraction plan

## Windows is a hard requirement

The Factory/Dyad runtime must run unattended on Windows without depending on:

- an interactive Electron renderer
- a logged-in desktop session
- UI automation
- CDP/Playwright control
- direct SQLite mutation
- manual copy/paste

The target is a normal long-running Windows process/service with explicit
startup, shutdown, health, logs and private-network configuration.

## Why this matches Dyad's own direction

Dyad's upstream plan `plans/multi-platform-web-and-mobile.md` selects
"Backend Service Extraction" as the intended architecture:

- extract Electron main-process business logic into a standalone Node.js server
- map existing Zod IPC contracts to HTTP
- extract pure service functions from IPC handlers
- abstract settings/secret storage away from Electron `safeStorage`
- abstract Electron-specific paths/runtime concerns

Factory is implementing the smallest production slice of that direction rather
than creating a parallel automation system.

## Extraction milestones

### M1 — transport-neutral execution seams

Status: in progress.

- create-app has a trusted non-renderer production seam
- chat execution no longer requires `WebContents`
- Factory protocol is versioned
- authenticated HTTP boundary exists
- deterministic source manifest exists

### M2 — platform-neutral runtime dependencies

Required before the runtime can be a Windows service.

Extract interfaces for the subset of platform dependencies used by the Factory
prototype path:

1. settings/secret access
2. user-data/app workspace paths
3. process/runtime logging
4. app runtime/preview process lifecycle

The production Electron application keeps adapters for the existing desktop
behavior. The Factory service uses Node/Windows adapters.

Do not add fake Electron objects to production.

### M3 — durable project + operation identity

The provider must persist:

- idempotency key -> operation identity
- Factory input SHA-256
- Dyad project/app identity
- chat identity
- terminal state
- source SHA-256
- preview reference
- provider request identity
- failure classification

A service restart must be able to answer `GET /v1/operations/{id}` without
guessing whether an accepted request ran.

### M4 — real create/build path

One request must execute the same Dyad application logic as the desktop app:

1. create/reuse app
2. create/reuse chat
3. configure admitted model
4. submit governed prompt
5. await terminal chat outcome
6. start/verify preview for functional prototypes
7. calculate canonical source manifest
8. persist terminal provider operation

### M5 — Windows service packaging

The release must provide deterministic Windows installation:

- pinned Node runtime compatibility
- service install/uninstall
- service account expectations
- data/workspace directory
- environment/secret configuration
- WireGuard/private bind address
- health probe
- graceful shutdown
- log rotation/location
- upgrade/rollback procedure

No Unix-only process assumptions may be introduced.

## Security boundary

The HTTP service is not a general remote shell.

Allowed API surface is restricted to Factory prototype operations. Callers
cannot provide arbitrary local paths or arbitrary commands.

Authentication is mandatory for all operation endpoints. Health may remain
unauthenticated but returns no secrets or customer data.

## Stop condition

If any milestone requires controlling the Electron UI or relying on a
test-only/private interface instead of extracting a production service seam,
stop and redesign before shipping.
