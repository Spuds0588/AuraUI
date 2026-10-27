# Delegated web tasks: the embedded browser and the session it carries

A design note for the two component kinds that hand work over instead of asking a question about
it — `WebTask` and `ESign` — and for the one mechanism they share: a session that is passed *into*
an embedded browser so the human picks up where the agent stopped.

Written because the rest of this repository is built on one sentence — *the canvas renders
declarative props and never executes agent-supplied code* — and these two kinds are the exception.
That exception should be argued for, not just implemented.

## Why a browser at all

The task is not a decision. It is *renew the insurance*, *finish the checkout*, *sign the lease*.
No arrangement of cards and buttons does that; the site does. So the canvas has to show a site.

Three ways were weighed.

**An `iframe` in the canvas.** No native code, no new APIs, and it fails on most of the sites worth
delegating to: `X-Frame-Options: DENY` and `SAMEORIGIN`, and CSP `frame-ancestors`, are exactly
what banks, insurers, carts and signing providers send. A component that works on a hobby site and
not on the one that matters is worse than one that plainly says what it needs.

**A second desktop window.** Fine technically, and the smallest change to the shell — but the card
would have to follow the human into another window to stay useful, and they would be reading the
agent's instructions in one place and doing the work in another. The embedded view keeps the
agent's sentence, the address, the page, the notes and the send button in one column, in that
order.

**A child webview inside the overlay window.** What is built. Two costs, both real: it needs
Tauri's `unstable` feature (`Window::add_child`, `WebviewBuilder`), and a native view is not part
of the DOM, so it cannot be laid out, animated or clipped by CSS. The card reserves a slot and the
shell places the view over it; the toolbar above the slot is drawn in canvas pixels precisely
because the page below cannot be trusted to draw an address.

**The fallback, if that unstable API turns out to be a problem on a given desktop:** the same
components with `openIn: "browser"` — rows hand their URL to the human's own browser, and the card
says the session could not come along. One setting, no rewrite, and it is what the phone build and
the scripted demo do anyway.

## What is injected, and in what order

A session is `storageState`-shaped, because the agent that has one to hand over is usually an agent
that was driving a browser itself:

```json
{ "label": "your portal login",
  "cookies": [ { "name": "sid", "value": "…", "domain": ".example.com", "path": "/",
                 "secure": true, "httpOnly": true, "sameSite": "lax" } ],
  "origins": [ { "origin": "https://portal.example.com",
                 "localStorage": [ { "name": "auth.token", "value": "…" } ] } ] }
```

Order matters, and this is the order:

1. The child webview is created with its **own data directory**, `.data_directory(...)`, one per
   run, so two tasks never share a cookie jar.
2. Cookies go in through `Webview::set_cookie`, before anything is loaded. Through the cookie API
   rather than `document.cookie`, which is the only way an `HttpOnly` login cookie can be carried at
   all. A cookie is placed only when its domain covers the host being opened.
3. `localStorage` is seeded by an **initialization script**, because that is the one hook that runs
   after the JS global exists and before the page's own scripts do — a token that the site reads on
   boot has to be in place before boot. The script is guarded by `window.location.origin` and
   wrapped in `try`: it runs on every top-level navigation, and a page whose storage is full must
   not be broken by a failed seed. Values are embedded as JSON, so a token containing a quote
   cannot end a string literal and become code.
4. The first navigation happens **last**, with everything above already in place. A protected page
   that loads logged out bounces to a login form, and the human has already lost.

The same view is reused for every row of one task, so a list of nine stops that all need one login
logs in once. The webview lives until the card is done with it; then the cookies it placed are
deleted and the run's directory is removed — unless the human ticked **keep the sign-in for this
list**, which is the one case where reuse is worth more than cleanliness.

## What the human is told before any of that happens

A sheet, in the card, naming the exact origins, the number of cookies and stored values, and what
it means: *anywhere this page is signed in, it can act as you*. Three buttons — hand it over, open
without it, always allow these sites. Values are never shown, because a sheet that displays a
credential turns every screenshot of the app into a leak, and the human does not need to read a
token to decide whether they trust a site.

Allowing it once does not allow it forever; the always-allowed list is per origin, lives in the
canvas's own `localStorage`, and can be cleared.

## What a session cannot do

Worth stating, because it is where expectations go wrong.

- **It cannot come from the human's own browser.** A Tauri webview is WebKitGTK (or WebView2, or
  WKWebView); the human's Chrome has its own profile and its own cookie store, and no API here
  reaches into it. A session has to be *given*, by the agent, in the payload.
- **It cannot be read back out.** There is no frame in either direction that returns the contents
  of the embedded browser. The agent gets the human's word, their notes, and files they chose to
  attach — not a scrape.
- **It does not follow a link out of the origin.** A page can navigate anywhere `https`, and the
  toolbar will say where it went, but the session's cookies do not travel to a domain that does not
  match them.
- **It is not a security boundary against the site itself.** A site that sets its own cookies,
  stores its own tokens and remembers the device will do exactly that inside its own data
  directory, for as long as that directory exists.

## The threat worth naming

An agent whose context contains page content can be steered by it. If that happens, the most
valuable thing it can do is ask the human to sign into a page it chose, inside a surface the human
has been trained to trust.

Nothing here makes that impossible. What it does:

- the origin is drawn in the canvas's own pixels, above the page, where the page cannot repaint it;
- the session ask is explicit, per origin, and never silent;
- the app's IPC is locked to the canvas webview by label, twice: in the capability file and in
  every command's own caller check, so a page inside the app cannot answer questions, open
  sessions, or read the bridge;
- no form is ever filled or submitted on the human's behalf;
- and nothing is kept that the human did not ask to keep.

That is mitigation, not immunity. The judgement being asked of the human — *do I recognise this
site* — is the same judgement their browser asks of them every day, which is why the card shows the
host and not a logo.

## Related

- `docs/PROTOCOL.md` §4 (`WebTask`, `ESign`) and §6 (security and scope).
- `src-tauri/src/webtask.rs` — the shell half: creation, placement, injection, cleanup.
- `src/lib/webview.ts` — the canvas half: host detection, commands, measuring the slot, consent.
- `src/lib/pdf.ts` — the signing half: pdf.js renders, pdf-lib writes, nothing is uploaded.
