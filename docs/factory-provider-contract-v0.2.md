# Factory provider contract v0.2 and operations

The provider keeps protocol `v1` on the wire. v0.2 adds fields the Factory Core
needs to meter, verify and reconcile an operation (ADR-0028 decisions 4 to 6).
The Core ignores nothing it needs and trusts nothing it can recompute.

## Operation fields added in v0.2

| Field                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`               | The Factory model identity the operation ran with (`provider`, `modelId`, `configSha256`): an echo of the admitted request, set at admission. The Core refuses a completion whose model differs from the one it requested.                                                                                                                                                                                                                               |
| `resolvedModel`       | The Dyad-side model the registry mapped the identity to (`provider`, `name`). Evidence of what actually ran.                                                                                                                                                                                                                                                                                                                                             |
| `usage`               | Provider-reported usage summed over every model run of the operation: `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `reasoningTokens`, `costMicros` + `currency` (only when the provider charged a cost, e.g. OpenRouter), `modelRuns`, `scope`. A dimension is present only if every run reported it; a run that never reported makes `usage` absent. Absent means unknown, never zero. A failed operation keeps the usage it spent. |
| `replayed`            | `true` only on the response to a `POST /v1/prototypes` whose idempotency key was already admitted. It is never stored, and a replay never starts a model run.                                                                                                                                                                                                                                                                                            |
| `build`               | Result of the verification build: `{ok, command, error?}`. A functional prototype completes only with `ok: true`; a failed operation carries the last failed build with a bounded `error`; absent for a static prototype (no build is run).                                                                                                                                                                                                              |
| `previewSourceSha256` | Equals `sourceSha256` when the files of the frozen source were intact while the preview was live. A frozen file that changed or disappeared fails the operation (`EXECUTION_FAILED`); files the preview itself adds (lockfile, caches) do not count.                                                                                                                                                                                                     |

`scope` states what the usage excludes: auxiliary model calls outside the build
agent run (for example context compaction) are not counted.

## Idempotency and reconciliation

- `POST /v1/prototypes` with the same `idempotencyKey` and `inputSha256` returns
  the stored operation with `replayed: true`; with another `inputSha256` it is
  `IDEMPOTENCY_CONFLICT`.
- `GET /v1/operations/{id}` returns the stored operation; a completed one gets
  its preview URL refreshed (and re-exposed on the private address) after a
  service restart.
- An operation that was `accepted` or `running` when the service restarted
  becomes `indeterminate` (`SERVICE_RESTARTED_DURING_OPERATION`) and is never
  replayed automatically.

## Token

The bearer token is read from `FACTORY_DYAD_TOKEN_FILE` on every request: one
token per line (`#` comments allowed), at most two, each at least 32
characters. Rotate by putting the new token first and keeping the old one on
the second line until the Core uses the new one, then delete the old line; no
restart. `FACTORY_DYAD_TOKEN` in the environment is refused at boot. Restrict
the file to the service account (`icacls <file> /inheritance:r /grant:r
"%USERNAME%:R"`).

## Network

- `FACTORY_DYAD_BIND`: address of the API (for the laboratory, the WireGuard
  address, for example `10.77.0.2`). Never `0.0.0.0` on a shared network.
- `FACTORY_DYAD_PREVIEW_BIND` + `FACTORY_DYAD_PREVIEW_ALLOWED_PEERS` +
  `FACTORY_DYAD_PREVIEW_PORTS` (default `49152-49300`): the preview gateway.
  Dyad starts each preview behind a proxy that listens on loopback only; the
  gateway listens on the private address in that port range, accepts only the
  listed peers and forwards HTTP and WebSocket traffic to the loopback proxy.
  Dyad's proxy answers 421 to any request whose `Host` (or browser `Origin`) is
  not its own `localhost:<port>`, so the gateway rewrites `Host`, and an
  `Origin` or `Referer` that names the gateway, on the way in, and a redirect
  `Location` back on the way out; it serves only requests whose `Host` is the
  gateway's own address (no DNS rebinding). `previewRef` is rewritten to the
  gateway URL. `preview_gateway_dyad_proxy.test.ts` runs the gateway in front of
  Dyad's real proxy worker.
- Firewall (`scripts/factory-provider/configure-firewall.ps1`): one inbound
  rule per Core host, naming the API port and the preview range. Laboratory:
  the Core on the operator's machine (`10.77.0.4`). Production: the Core on the
  VM (`10.77.0.1`): remove the laboratory rule, then add the VM's. Never both
  as a permanent state.

## Model registry

`FACTORY_DYAD_MODEL_REGISTRY_FILE`: entries are looked up by `configSha256`,
which the Core computes from its active model configuration; provider and id
must match too. Example (shas are placeholders):

```json
{
  "models": [
    {
      "configSha256": "<sha of the Core's ollama/qwen3.5:9b configuration>",
      "factoryProvider": "ollama",
      "factoryModelId": "qwen3.5:9b",
      "dyad": {
        "provider": "ollama",
        "name": "qwen3.5:9b",
        "effortLevel": "medium"
      }
    }
  ]
}
```

## Provenance

`GET /healthz` returns `dyadVersion` and `dyadCommit` from
`FACTORY_DYAD_BUILD_VERSION` / `FACTORY_DYAD_BUILD_COMMIT`.
`scripts/factory-provider/start-factory-dyad-provider.ps1` fills them from the
checkout it runs in and refuses to start from a dirty working tree, so the
commit always describes what was built.
