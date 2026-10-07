# Factory provider contract v0.4: `limits`

Adds to v0.2 (usage, model, replay) and v0.3 (preview gateway, build result). The wire `protocolVersion` stays `"v1"`: the change is one optional request field and one new error code.

## Request

`POST /v1/prototypes` may carry:

```json
"limits": {
  "maxTotalTokens": 400000,
  "maxCostMicros": 250000,
  "prices": { "inputMicrosPerMtok": 100000, "outputMicrosPerMtok": 500000, "cacheReadMicrosPerMtok": 10000 }
}
```

- At least one of `maxTotalTokens`, `maxCostMicros` (positive integers). Without `limits` nothing changes.
- `maxCostMicros` **requires** `prices` (micro-USD per million tokens; `cacheReadMicrosPerMtok` defaults to the input price). The service refuses, at parse time, a cost ceiling it cannot measure.
- The Core owns the real price and the final cost. The service only bounds its own spending.

## Behavior

- After every model step the agent checks the ceilings (`stopWhen`), counting the runs already finished plus the run in flight. Cost is the **higher** of the charge the provider reported and the price-table figure, so the cut is conservative.
- The agent stops after the step that reaches a ceiling (`>=`). The build turn loop never starts another turn once a ceiling is reached, and no verification build or preview runs.
- The operation ends `failed` with `errorCode: "LIMIT_REACHED"`, an `errorMessage` naming the ceiling, the usage so far (`usage`) and the model; `limits` is echoed in the operation.
- A single model step can overshoot a ceiling by its own size: the ceiling is a stop condition, not a hard meter. The Core settles the real cost from `usage`.

## Not covered

Auxiliary calls outside the build agent run are not seen by the service (same `scope` as the usage figures).
