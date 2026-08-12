# Computer Use security contract V1

[简体中文](COMPUTER-USE.md) · English

The Useful Computer Use contract is a provider-neutral security boundary. It is not a desktop
automation product.

Schema identity is fixed: `useful.computer-use.v1`.

The default provider is always off. It returns stable error `COMPUTER_USE_DISABLED`.

This package does not:

- create ActionDescriptors
- register MCP tools
- connect model APIs
- control the user mouse, keyboard, or desktop

## Trust boundary

- Allowed providers: `isolated-browser` and `isolated-vm` only. `host-desktop` is rejected. Config
  cannot enable it.
- Default domain allowlist is empty. Empty allowlist means offline mode. Network evidence is rejected
  in offline mode.
- When network is enabled, each observe/commit must report a complete hop chain with
  `complete: true`. Each hop needs a credential-free HTTP(S) URL and resolved IP. Domain, IP, and
  redirect counts are checked.
- localhost, single-label hosts, IPv4-mapped IPv6, unspecified, loopback, private, link-local,
  multicast, reserved/documentation ranges, and common metadata addresses are rejected by default.
  Explicit development config needs both `developmentMode: true` and `allowPrivateDomains: true`.
  Production defaults never enable that pair.
- Sessions enforce `maxSteps`, per-step deadline, total deadline, screenshot byte limit, and max
  redirects. Provider calls receive `AbortSignal`.

## Two-phase execute

Providers must implement `createSession`, `observe`, `execute`, and `close`.

`execute` is mandatory two-phase:

1. `prepare` must be side-effect free. It returns opaque `preparedActionId`, provider safety checks,
   and risk flags.
2. The contract merges model safety checks, provider safety checks, and contract-generated checks for
   high-impact actions.
3. Each check needs its own explicit approval callback. Approval binds `preparedActionId`, step,
   observation digest, normalized action digest, and the frozen action. Missing callback, reject, or
   invalid approval ID fails closed.
4. `commit` runs only after all approvals. Providers must not apply user actions in `prepare`,
   `observe`, or `createSession`.

`click`, `double-click`, `drag`, `type`, and `key` are always high-impact. Providers may raise other
actions to high-impact. Providers cannot lower fixed contract classifications.

One operation slot exists per session. observe, execute, and close are strictly serial.

Each action needs a strictly monotonic `step` and the SHA-256 digest of the latest observation. Missing
observation, stale digest, replayed step, skipped step, and concurrent actions are rejected.

When an action enters the execute path, that step is consumed and the latest digest is cleared. After
success or failure, the caller must observe again and use the next step.

`close` bumps session generation, cancels the internal signal, and waits for the operation slot.
Late observation/prepare/approval after the generation fence is rejected.

If commit has not started, late work cannot enter commit. If commit started and the provider ignores
abort, the result is unknown. The session is poisoned and closed. Adapters must force-stop work in
the isolated browser/VM layer. JavaScript `AbortSignal` is not a process or network firewall.

V1 action closed set:

`screenshot`, `click`, `double-click`, `drag`, `move`, `scroll`, `type`, `key`, `wait`

Unknown actions and unknown fields are rejected.

## Audit and privacy

Audit events include only contract/event/session/prepared/approval IDs, time, action type, allowed
domains, coordinates, observation/action digests, screenshot size, safety check IDs, and result codes.
External IDs and result codes must match `SAFE_ID`.

Audit events never include screenshot bytes, typed text, key content, provider handles, approval
descriptions, tokens, or secrets.

Before commit, the contract writes a metadata-only `authorization` audit. If that sink fails, commit
does not run. If post-commit `action` audit fails after an irreversible action, the call returns
`AUDIT_FAILED` and the session poisons/closes. The contract does not claim the action did not happen.

Network evidence is provider-reported contract evidence. It is not a firewall. Trusted sandbox
adapters and network layers must enforce the same allowlist/IP policy on real DNS, each connection,
and each redirect. Do not trust only provider self-report fields.

## Adapter boundary

OpenAI and Anthropic Computer Use adapters must live in separate packages later. Host messages, tool
schemas, loop control, model IDs, and API credentials stay out of this contract. Adapters only map
their protocol onto this session/observation/prepare/approval/commit state machine.

`@useful/computer-use-browser-adapter` provides an owner-approved, host-injected isolated browser
adapter interface only. It is not a default provider, browser distribution, Playwright wrapper,
firewall, or full Computer Use product. It does not register Actions/MCP. It does not control the
host desktop.

It accepts `isolated-browser` only. Before a real browser context is created, a host network guard
must authorize a fixed normalized `startUrl`. The guard must enforce per-request policy, all DNS
addresses, each redirect hop, and effective port. Evidence must come from the guard.

The host context is a narrow trusted interface: observe, nine fixed action primitives, and idempotent
close. No arbitrary navigation, eval/JavaScript, file/download, clipboard, extension, raw
browser/page handle, or desktop handle.

Observe returns a host-issued `documentToken`. Each commit passes that token back. The host must
rotate the token when the top-level document changes. Stale tokens fail closed before input.

## Probe

```console
pnpm useful -- computer-use probe --json
```

The probe checks the bundled contract, fixed action-type closure, disabled default controller,
host-desktop rejection, and presence of the host-injected browser-adapter interface. It does not
start a browser. It does not use the network. It does not inject input. It does not enable a provider.

## Related pages

- Agent CLI/MCP overview: [AI Integration](AI-INTEGRATION.en.md)
- Product limits: [Known limitations](KNOWN-LIMITATIONS.en.md)

Full Chinese detail: [COMPUTER-USE.md](COMPUTER-USE.md).
