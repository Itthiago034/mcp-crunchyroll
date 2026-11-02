# Validation with a real browser and concurrent requests

*Portuguese version: [pt-BR](pt-BR/validacao-navegador.md).*

## Fixture correction — 2026-11-02

PR #5's Node 18 and 20 jobs failed at the assertion that all oversized streams
stopped before the server sent 1 MiB. The truncation and response-byte-limit
assertions had passed. The previous fixture wrote 16 KiB every 2 ms, so that
server-side assertion also depended on scheduling and browser/network buffering.
The fixture now advertises a 1 MiB response, sends only the requested budget
plus 16 KiB, and holds the remainder open. It still requires truncation, a
bounded returned body, peer cancellation before a complete response, and zero
active requests. This checks cancellation against an unfinished real HTTP
response without racing a timer-driven producer. Historical measurements below
describe the earlier fixture; this correction is not a new provider measurement.

The initial cloud measurements use Chromium 151.0.7922.173 with its native sandbox
enabled and Node.js 24.19.0. The authenticated Linux validation section separately
records the report submitted by the operator of their PC. Results are observations
from those runs, not an estimate of Crunchyroll's capacity.

## Controlled load

The `test/browser-load.test.ts` test starts a real browser with a temporary
profile, navigates to a local HTTP/1.1 server, and calls the frozen production
function `CRUNCHYROLL_FETCH_FUNCTION` through CDP with structured arguments.
There is no mock of `fetch`, `Response`, streams, or sockets. The production
origin remains restricted to Crunchyroll; the fixture uses CDP directly only
in the test, without changing that policy or fabricating an authenticated identity.

A total of 317 logical requests were executed:

| Scenario | Count | Expected and observed result |
| --- | ---: | --- |
| JSON/Unicode at concurrency 1, 6, 24, and 64 | 256 | HTTP 200, correct response identification, no truncation |
| Recovery after CDP saturation | 1 | HTTP 200 in the same browser and connection generation |
| HTTP 429 and 503 failures | 24 | Status preserved, without turning failure into success |
| Redirects | 12 | Opaque manual redirect; the destination received no request |
| Reset connections | 12 | `fetch` failed without bringing down the CDP connection |
| 1 MiB responses | 12 | Truncation and cancellation before the full response was sent, with 4 KiB and 512 KiB limits |

The profile contained a real fixture cookie. No request from the production
function sent it, demonstrating `credentials: "omit"`. The test also launched
128 simultaneous CDP commands, rejected the 129th at capacity, and verified
subsequent recovery. At shutdown, the browser was `STOPPED` and no HTTP request
remained active.

### Isolated run metrics

The fixture adds a 20 ms delay per JSON response. Each stage sends 64 requests;
latencies include browser queuing, the local network, and CDP.

| Requested concurrency | Peak HTTP requests at the server | Stage duration | p50 | p95 | Requests/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1,526.46 ms | 23.18 ms | 27.69 ms | 41.93 |
| 6 | 6 | 273.89 ms | 24.76 ms | 26.27 ms | 233.67 |
| 24 | 6 | 246.95 ms | 85.81 ms | 91.88 ms | 259.16 |
| 64 | 6 | 243.15 ms | 130.79 ms | 237.75 ms | 263.21 |

For this HTTP/1.1 origin, increasing concurrency from 6 to 64 increased waiting
time while the observed peak remained at 6 active requests. This identifies
per-origin browser queuing in this fixture. It does not demonstrate the same
limit on the real Crunchyroll service, which may negotiate different protocols or policies.

There were 323 observed HTTP attempts for the 317 logical requests: 6 extra
attempts occurred exclusively on GETs with resets. Each GET in that fixture
had 1 to 3 attempts. Chromium itself can retry requests; the MCP implemented
no retries in this run. No duplication occurred in the other scenarios.
Chromium's official network source describes retries in
[HttpNetworkTransaction](https://github.com/chromium/chromium/blob/main/net/http/http_network_transaction.cc).
This result does not establish the absence of native retries for mutations.
The two-retry `kMaxRetryAttempts` limit does not apply to the
`ShouldResendRequest` path for errors before headers on a reused connection.
In a later suite run, one fixture GET had seven attempts. The test now counts
the sockets existing before the reset batch and checks that the total number
of extra attempts does not exceed that set: each reset destroys a socket,
and a new connection is not yet eligible for that resend. The initial report
above remains an observation from that particular run.

Run data: [browser-load.json](validation-results/browser-load.json).

## Real Crunchyroll service

Another real Chromium instance was also started with a temporary profile for
HTTPS navigation and 6 anonymous reads at concurrency 2. The probe sent no
cookie or authorization header; bodies were cancelled after the headers and
were not recorded.

| Destination | Reads | Result |
| --- | ---: | --- |
| Home page | 2 | HTTP 200 |
| `robots.txt` | 2 | HTTP 200 |
| Categories API | 2 | HTTP 401, because there was no authentication |

The browser received provider responses and was shut down. This validates
HTTPS connectivity through the browser route and the authentication requirement,
without validating API content or authenticated operations.

Access through `curl` returned `CONNECT tunnel failed, response 403` from the
proxy, while Chromium obtained HTTP 200. The block observed on that route
therefore must not be generalized to all environment connectivity.
Permissions for `www.crunchyroll.com` and `sso.crunchyroll.com` were saved in
the draft, preserving existing presets. The draft does not apply or publish
changes: to persist that configuration, review and save it in the environment
settings and publish.

Run data: [live-browser-probe.json](validation-results/live-browser-probe.json).

## Authenticated cloud attempt — blocked

The `scripts/validate-live.ts` runner initialized the real MCP over stdio and
confirmed its 21 tools. `crunchyroll_status` returned `LOGIN_REQUIRED`, with
no authenticated session. The `--login` attempt confirmed the absence of
`DISPLAY` and an available interactive sign-in interface on that machine;
no password or token was requested or invented.

The runner is prepared for 12 authenticated reads at concurrency 2 using
categories, search, and browse, without mutations or retries. It checks the
shape and count of the returned collections and reports operation, result,
and duration without account content or credentials. **Those 12 reads were
not executed in that cloud attempt.** Exit code 2 signals a missing prerequisite
without counting the scenario as passed.

Attempt data: [live-mcp.json](validation-results/live-mcp.json).

## Authenticated validation on the Linux PC — passed

On 2026-10-08, the operator submitted execution output from CachyOS/Linux at commit
`a59dd134d9b84474517fda564783e71f8a57c584`, using `/usr/bin/chromium`.
The build passed. The local session persistence test across two subprocesses
passed in 840.23 ms, with no failure or skipped test. The exact browser and
Node versions do not appear in that execution report.

Manual preparation ended normally, the MCP confirmed authentication and
connection with `authState: "PROFILE_READY"`, and all 12 read calls passed
at concurrency 2: `complete: true`, `status: "passed"`, zero failures, and
no blockers. There were four category calls, four Naruto searches, and four
browse calls. The runner checked collection shape and count.

| Tool | Passed calls | Mean | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Categories | 4/4 | 433.23 ms | 265.40 ms | 606.39 ms |
| Search | 4/4 | 676.71 ms | 315.23 ms | 1,740.07 ms |
| Browse | 4/4 | 478.25 ms | 7.41 ms | 1,806.96 ms |

These are MCP call latencies, including transport, current authentication,
network/browser, and normalization. The report does not measure time to
headers, TLS, RSS, total batch duration, or physical network attempts. The
production function does not set `fetch.cache`; the browser HTTP cache may
participate in these reads. The calls repeat the same arguments. Lower
latency on later reads was observed, but cache, warm-up, and provider variation
were not isolated. Four samples per operation do not establish a provider
bottleneck or justify introducing caching in the MCP.

That run demonstrates the manual preparation → persistent profile → MCP
authentication → reads flow on that PC. Graphical/desktop session variables
and the subprocess environment were aligned before the passing run. The
sequence of results does not isolate which change caused the pass, prove a
specific keyring selection, rule out future challenges, or prove continuity
after rebooting the PC. No account mutation was tested.

Provenance: the JSON was transcribed from output supplied by the user; this
run was neither performed nor remotely observed by the agent. No cookies,
tokens, account data, or collection content were received. Previous attempts
remain recorded, and the cloud result was not overwritten.

Run data: [live-mcp-linux.json](validation-results/live-mcp-linux.json).

## Reproduction

### Security verification stuck in the managed browser

A Cloudflare verification page does not, by itself, demonstrate a password
error or lack of connectivity. The repository already records a manual
sign-in attempt in the same dedicated profile in
[BT4-N5](../CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md). That historical record
does not prove the procedure will work on another machine or browser.

The `npm run validate:live -- --login` runner now integrates manual preparation
before attempting authentication through the managed browser when the MCP
session is unauthenticated. It waits for the manual window to close normally
and only executes the 12 reads after explicit confirmation of authentication
and connection by the MCP. A profile lock or preparation failure prevents the
managed attempt.

The manual stage can also be tested separately. Close the managed window and
stop the validation runner before executing:

```bash
npm run onboard:browser
```

The command uses the same browser resolver as the MCP and the same dedicated
profile with the documented launch options, without a debugging port, MCP,
or CDP. It rejects a profile with `SingletonLock`, including a dangling symlink,
and does not delete session controls. It accepts no login, URL, profile, or
flag arguments. Complete verification and sign-in manually on the provider's
page, decline any import of data from another browser, and close the window
normally. The script does not read cookies, fields, page content, or authentication state.

Then execute `npm run validate:live -- --login` to validate MCP authentication
and the 12 reads; it will reopen the manual stage in the same profile.
Report separately whether manual sign-in worked and whether the MCP completed
those reads. A successful browser exit is not a passed authentication test.
The report distinguishes preparation, managed validation, and reads. If the
manual window closes but the MCP does not authenticate, it returns
`auth_not_established_after_manual_browser` and zero reads, without repeating sign-in.

If verification also fails in that direct launch, the problem does not depend
exclusively on MCP/CDP execution. If it works and fails again in the MCP, a
difference in managed execution is a hypothesis to investigate. The test
does not isolate CDP from other execution differences. Success in Firefox or
another browser does not establish this Chromium instance's result.

### Installation and validation commands

On CachyOS/Arch, install a supported browser with
`sudo pacman -S --needed chromium` and run validation as a normal user.
npm 12 blocks dependency scripts by default; the project approves only
`esbuild@0.28.2` in `allowScripts`, allowing its postinstall without allowing
scripts from other dependencies. Installation, type checking, and build were
also verified with npm 12.2.0.

```bash
# Controlled load: requires Chromium and its working sandbox.
CRUNCHYROLL_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser

# Anonymous reads on the real site, without sign-in.
node --import tsx scripts/probe-live-browser.ts

# On a machine with a visible browser and provider access:
npm run build
npm run validate:live -- --login
```

In the cloud, run the Chromium test outside the additional command isolation
when it blocks namespaces; keep the browser sandbox enabled. Sign-in takes
place exclusively in browser windows through Crunchyroll's interface; the
runner first uses the manual stage in the dedicated profile.
The runner explicitly forwards graphical session variables (`DISPLAY`,
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE`, `XAUTHORITY`, and
`DBUS_SESSION_BUS_ADDRESS`) and browser/sandbox overrides to the MCP process.
The SDK does not inherit them by default: without forwarding, the terminal
may detect a graphical session while the browser started by the MCP cannot
open a window. Forwarding uses a restricted list and does not log variable values.
The manual and MCP stages also use the same subprocess environment, including
`XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, KDE/GNOME identifiers, and XDG
directories. Chromium uses session identifiers to recognize the Linux desktop;
changing them between stages is a difference that may affect protected storage.
The runner neither selects insecure storage nor copies cookies.
A synthetic-session test with real Chromium verifies persistence in the same
profile after restarting the browser in another subprocess through the SDK.
Both fixture runs use headless mode and CDP for normal shutdown in the cloud.
This local test does not prove manual sign-in, Crunchyroll account continuity,
or keyring behavior on your PC.
Run it separately with `npm run test:handoff`. The Linux wrapper also runs it
before provider probes. Chromium's desktop selection is implemented in
[GetDesktopEnvironment](https://github.com/chromium/chromium/blob/main/base/nix/xdg_util.cc).
Managed shutdown uses `Browser.close` and waits for process exit to allow
the profile to be written. For processes started by the MCP itself, if exit
does not occur within one CDP command deadline, it falls back to `SIGTERM`;
only after a second deadline without exit does it use `SIGKILL`. Those recovery
paths do not guarantee session persistence. Adopted processes still receive
no operating system signals.
After authenticated validation, close that window; the runner closes the
MCP process but neither calls logout nor deletes the user's session.

JSON reports can be saved to chosen paths using `CRUNCHYROLL_LOAD_REPORT_PATH`,
`CRUNCHYROLL_LIVE_PROBE_REPORT_PATH`, and `CRUNCHYROLL_LIVE_REPORT_PATH`,
respectively. These are output paths, not credentials. The default suite uses
local fixtures; real provider probes run only through explicit commands.

When `CRUNCHYROLL_LIVE_REPORT_PATH` is set, the runner also saves the current
phase. `complete: false` and `status: "running"` indicate a run without a final
result; they do not represent a pass. The final JSON uses `complete: true`.

## Session persistence fix at shutdown

In CI run `37868812177`, the resumption test failed on Node 20 and 22: the local
server received the second navigation without the expected synthetic cookie.
The same failure was reproduced in the cloud with Chromium 151.0.7922.173,
Node 20.20.2, and the previous code by repeating the isolated test. The process
started by the MCP received `SIGTERM` directly, without first requesting
shutdown through CDP.

After using `Browser.close` and waiting for process exit, 20 consecutive
isolated resumption test runs passed. The full suite passed with 1,031 tests,
zero failures, and zero skipped tests on each version: Node 18.20.8, 20.20.2,
and 22.23.3. The load test with corrected connection counting also passed on
all three versions. Unit tests verify that the response to the close command
does not replace waiting for exit, that normal shutdown sends no signals,
and that the two recovery deadlines are respected.

These checks used local sandboxed Chromium, fixtures without an account,
and `umask 022`. The cloud shell's `077` mask makes an old fixture's attempt
to create an insecure directory with `mkdir` secure, causing a separate test
failure; it does not indicate session loss. CI's Chrome for Testing 131 was
not run on that machine: its download returned 403. The new GitHub run's
passing status must be checked separately.
