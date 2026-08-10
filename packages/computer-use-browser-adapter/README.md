# `@useful/computer-use-browser-adapter`

This package adapts a host-owned, isolated browser context to
`@useful/computer-use-contract`. It is not a browser distribution, a sandbox, a
firewall, a Playwright wrapper, or a complete Computer Use product. It has no
network dependency and does not register an Action, MCP tool, CLI command, or
GUI surface.

The host must inject both `createContext` and a mandatory network guard. The
guard is opened, and therefore authorizes the fixed `startUrl`, before a real
browser context is created. The adapter only accepts a guard declaring all of
these exact host-enforced capabilities:

```js
const enforcement = {
  transport: "host-enforced",
  requests: "every-request",
  dns: "all-addresses",
  redirects: "every-hop",
  ports: "explicit",
};
```

`networkGuard.open({ startUrl, policy }, { signal })` must reject a disallowed
start URL before resolving. It returns exactly `{ binding, evidence, close }`.
The opaque `binding` must put the browser's real transport behind the guard;
`evidence({ signal })` returns complete accumulated network evidence from that
guard, not claims obtained from the browser driver. The guard must resolve and
check every DNS address, every request, every redirect, and the effective port
before allowing the connection. Its `close` operation must be idempotent.

`createContext({ startUrl, networkGuardBinding }, { signal })` receives that
binding and returns exactly these methods:

```text
observe, screenshot, click, doubleClick, drag, move, scroll,
typeText, pressKeys, wait, close
```

The context is expected to perform the initial navigation to `startUrl` through
the binding. There is deliberately no arbitrary navigation, JavaScript/eval,
file, download, clipboard, extension, raw page/browser, or host-desktop handle.
Every action primitive returns exactly `{ resultCode }`; `observe` returns
exactly `{ screenshot, url, documentToken }`. The host context is a trusted
enforcement interface: it must issue a new safe `documentToken` whenever the
top-level document changes and reject an action whose adapter-supplied token is
stale. This is an integration requirement, not a capability claim supplied by
a page or browser driver. Context `close` must be idempotent and must forcefully
terminate in-flight work when its signal is aborted.

The first `close` attempt permanently shuts admission for that session, even if
resource cleanup fails. Only another `close` call may retry afterward; observe,
prepare, and commit remain rejected. Cleanup is ordered: the browser context
must confirm close before the network guard is released. A context-close failure
therefore keeps the guard enforcing and leaves a retryable tombstone.

```js
import { createIsolatedBrowserProvider } from "@useful/computer-use-browser-adapter";

const provider = createIsolatedBrowserProvider({
  createContext,
  startUrl: "https://example.com/",
  networkGuard,
});
```

Only `policy.environment === "isolated-browser"` is accepted. `prepare` never
calls the driver. `commit` consumes a prepared record once and maps the closed
Computer Use action set to the methods above. Screenshots and typed text are
never logged by this package. If an action has started and its result becomes
unknown, the session is poisoned and context/guard shutdown begins; the
contract controller independently applies the same conservative close rule.

Failed cleanup of invalid, partial, or abort-late acquisitions is retained in an
internal quarantine registry instead of being dropped. Integrators may call the
narrow, idempotent `provider.reapQuarantine({ signal })` maintenance method; it
returns only `{ remaining, closed }` and preserves failures for another retry.
The Computer Use controller does not call or expose this method by default, and
the adapter still registers no Action, MCP tool, CLI command, or GUI surface.

Cleanup uses identity-based resource leases. Every raw context/guard identity
has one close state and each acquisition holds separate driver and guard claims.
A guard claim is installed as pending before `createContext`; no identity that
is closing, closed, or has a failed close may accept another claim. Physical
close begins only after every claim requests close and every guard claim's
driver dependency is confirmed closed. This also keeps shared resources and
cross-role dependency cycles as retryable tombstones instead of closing early.
