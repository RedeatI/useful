# Action recipe example

[`json-base64.json`](json-base64.json) is a complete `useful.action-recipe.v1` request. It minifies
an embedded JSON value, passes the completed step's text output to Base64 encoding, and selects the
encoded value as the final output.

From the repository root, validate the plan without running its steps:

```powershell
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --validate-only --output json
```

Run it:

```powershell
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --output json
```

The final `output.encoded` value is `eyJhIjoxfQ==`. A real run also returns one redacted execution
receipt for each step; receipts do not contain the input or output body.

Recipes are deliberately small and closed: at most 16 ordered steps, a 1 MiB request, 8 MiB of
accumulated intermediate values, and 60 seconds for the complete recipe. Every step also keeps its
Action descriptor timeout. A step must name a canonical Action that is currently exposed by the
active profile and is read-only, non-destructive, idempotent, and closed-world, with no required
confirmation, permission, capability, or side effect.

Use exact `$ref` objects for data flow. A pointer may read `/input/...` or
`/steps/<completed-id>/output/...`; forward references, aliases, string interpolation, expressions,
scripts, file access, network access, and process access are rejected.
