# MTXcord web app

The `mtxcord-web` service: a Next.js app with the player, login, viewer access control, the streamer dock (`/dock`) and the browser streaming panel (`/stream`). It proxies WebRTC signaling to the [media server](../mediamtx/README.md) after checking each viewer's access; the video itself flows directly between the browser and MediaMTX.

Back to the [main README](../README.md).

## Configuration

Set these in the `.env` next to `docker-compose.yaml`. Variables shared with the media server (`STREAMER_PASSWORD`, `HOOK_SECRET`, `PLAYER_DOMAIN`) are described in the [main README](../README.md#shared-variables).

| Variable                  | Description                                       |
| ------------------------- | -------------------------------------------------- |
| `NEXTAUTH_SECRET`         | Required. Random secret used to sign session cookies; anyone who knows it can sign in as the streamer. Generate one with `openssl rand -hex 32` |
| `NEXTAUTH_URL`            | Public URL of the web app                          |
| `NEXTJS_PORT`             | Host port the web app is published on (default `8080`) |
| `CLIENT_IP_HEADER`        | Header the reverse proxy puts the client's IP in (default `x-forwarded-for`), see [Client IPs](#client-ips) |
| `DISCORD_WEBHOOK_URL`     | Default Discord webhook used for stream online/offline notifications, see [Discord webhooks](#discord-webhooks) |
| `DISCORD_WEBHOOK_URLS`    | Optional per-path webhook overrides, see [Discord webhooks](#discord-webhooks) |
| `DISCORD_CLIENT_ID`       | Discord OAuth application client ID                |
| `DISCORD_CLIENT_SECRET`   | Discord OAuth application client secret            |
| `NEXT_PUBLIC_DISCORD_ENABLED` | Set to `true` to show the "Sign in with Discord" button on the login page |
| `DISABLE_DOCK_AUTH`       | Set to `true` to skip authentication on `/dock` and `/stream`. **Everyone who can reach the app then has full streamer control**, so only use it when the app isn't reachable from the internet |
| `DENIAL_TIMEOUTS`         | Comma-separated minutes a kicked or denied viewer is kept out, growing with each repeat kick or denial within an hour; the last value repeats (default `1,5,15`) |
| `GUEST_AVATAR_FILTER_ID`  | Derpibooru filter used for guest avatars (optional, defaults to Derpibooru's default filter), see [Guest names and avatars](#guest-names-and-avatars) |
| `GUEST_AVATAR_BOORU_URL`  | Base URL of the Derpibooru API used for guest avatars (optional, default `https://derpibooru.org`; any Philomena-based booru works) |
| `GUEST_AVATAR_TAGS`       | Extra Derpibooru tags every guest avatar must have (optional), see [Guest names and avatars](#guest-names-and-avatars) |
| `GUEST_PONY_NAMES_FILE`   | File with guest pony names replacing the built-in list (optional), see [Custom pony names](#custom-pony-names) |
| `MEDIAMTX_HOST`           | Hostname/IP of the media server the WHEP/API proxy talks to (default `mtxcord-media`) |
| `MEDIAMTX_PORT`           | Port of the media server's WebRTC signaling (default `8889`) |
| `MEDIAMTX_API_PORT`       | Port of the media server's MediaMTX control API, used by `/dock` (default `9997`) |
| `MTXCORD_DB_PATH`         | Overrides the SQLite database path (default `/data/sqlite/mtxcord.db`; meant for tests and running outside Docker, where the default resolves to the current drive's root) |

## Viewer access

Viewers sign in with Discord or with the stream's viewer password; the streamer signs in with `STREAMER_PASSWORD` on `/dock`.

Viewer passwords are stored per path in the SQLite database. There's none until you press the rotate button next to "Current Viewer Password" in the dock, which generates a new random one (and replaces the old one every time after). A path without a password of its own uses the `default` path's password. Rotating a password signs out every guest using it and drops their connection; Discord viewers aren't affected.

Each stream is either:

* **Private** (the default): a signed-in viewer waits on a "waiting for approval" screen until you approve or deny them in the dock. Discord viewers are approved by account, guests by IP (see [Client IPs](#client-ips)). Approvals last until the stream stops or restarts.
* **Public**: anyone signed in can watch right away. Discord viewers get a pony name too, so everyone is anonymous to each other.

Kicked or denied viewers are kept out for a while, longer with each repeat (see `DENIAL_TIMEOUTS`), and see a countdown until they can try again. Approving them clears the timeout.

The player URL posted to Discord never contains credentials - viewers sign in on the login page.

## Guest names and avatars

Viewers who log in with the stream password get a pony name, e.g. *Fluttershy* or *DJ Pon-3*. On public streams, Discord viewers get one too, so everyone watching is anonymous to each other. The streamer dock shows each pony next to the viewer's IP and, for Discord viewers, their Discord account.

A guest keeps the same pony for the whole stream, including across page refreshes and reconnects, and gets a new one when the next stream starts. Guests who like theirs can click the pin next to their name in the viewer list to keep it for future streams, and click it again to get a new one next time. Guests can get a different picture of their pony with the 🎲 button next to their name, once every 30 seconds; the streamer can do the same for anyone with the 🎲 button in the dock's viewer list (without the wait). Identities are stored in the SQLite database, so they survive restarts.

Each guest also gets an avatar: a solo picture of their namesake, looked up through the [Derpibooru API](https://derpibooru.org/pages/api). Images are hotlinked from Derpibooru's CDN. Nothing is downloaded; only each guest's chosen image URL is saved with their identity.

Searches go to `https://derpibooru.org` unless `GUEST_AVATAR_BOORU_URL` points at another Philomena-based booru. They use Derpibooru's default filter. To use a different one, set `GUEST_AVATAR_FILTER_ID` to the ID of any [Derpibooru filter](https://derpibooru.org/filters) (the number in the filter's URL).

`GUEST_AVATAR_TAGS` narrows avatars down further: a comma-separated list of [Derpibooru tags](https://derpibooru.org/tags) every avatar must also have. Prefix a tag with `-` to exclude it instead. For example:

```env
GUEST_AVATAR_TAGS=cute,smiling,-sad
```

Tags are combined with the guest's pony and the filter. If a pony has no matching pictures, the guest gets a generic pony picture with the same tags instead. Changing either setting re-picks existing avatars that no longer match.

Guests can also pick one favourite tag of their own with the 🏷 button next to their name, e.g. `cute` or `hat`. It only affects their own pictures, on top of `GUEST_AVATAR_TAGS`, and stays with them across streams, even when they get a new pony. If their pony has no pictures with that tag, it's ignored until they get one that does. Changing it picks a new picture, so it shares the 30-second wait with the 🎲 button.

### Custom pony names

`GUEST_PONY_NAMES_FILE` replaces the built-in list of names with your own: a text file with one pony per line, optionally followed by `|` and the Derpibooru tag used to find its pictures (by default, the name itself). Empty lines and lines starting with `#` are ignored:

```text
# Mane six only
Twilight Sparkle
Rainbow Dash
Pinkie Pie
Rarity
Applejack
Fluttershy
Best Pony | derpy hooves
```

The `config` folder is already mounted into the container, so the easiest place for it is `config/pony-names.txt` with `GUEST_PONY_NAMES_FILE=/data/pony-names.txt`. The file is read on startup, so restart the container after editing it. Changing the list gives guests new ponies (kept ones too) and new pictures to match. If the file can't be read or has no names, the built-in list is used and an error is logged.

## Discord webhooks

When the media server's [hooks](../mediamtx/README.md#hooks) report a stream going online or offline, the web app (`lib/discordWebhook.ts`) posts one message when the stream first goes online, then edits that same message in place on every subsequent online/offline transition instead of posting a new one each time. The message id is persisted in the SQLite database, so edits keep working across restarts, and if the stored message was deleted manually (or the webhook URL changed), a fresh message is posted and tracked instead. The player link in it is built from `PLAYER_DOMAIN`.

By default, every path notifies the same `DISCORD_WEBHOOK_URL`. To send some paths to a different Discord channel, list `path:url` pairs, separated by commas:

```env
DISCORD_WEBHOOK_URLS=desktop:https://discord.com/api/webhooks/...,gaming:https://discord.com/api/webhooks/...
```

A path not listed here falls back to `DISCORD_WEBHOOK_URL`.

## Client IPs

Guests (viewer password) can only be told apart by IP, so approvals, kicks and denials for them depend on the web app knowing each viewer's real IP. It takes it from the header named by `CLIENT_IP_HEADER`, which your reverse proxy must set:

* `x-forwarded-for` (default): the **last** entry is used, the one added by the proxy right in front of the web app. Works with a single proxy such as NGINX, Caddy, Traefik, Cloudflare or a Cloudflare Tunnel.
* With several proxies, e.g. Cloudflare in front of NGINX, the last entry is the outer proxy's address. Use a header the outer proxy sets instead, such as `cf-connecting-ip`, and make sure the web app is only reachable through it, or clients can send that header themselves.

Without a reverse proxy, clients can pick their own IP, so don't expose the web app directly.

## Streamer HUD / OBS Custom Browser Dock

A private streamer dashboard is available at `/dock`, gated by its own login (`STREAMER_PASSWORD`) - separate from both the Discord login and the per-stream viewer password, so viewers can never reach it.

The web app reads MediaMTX's control API (`mtxcord-media:9997/v3/`) for it and pushes the dock everything it shows (see [Live updates](#live-updates)).

Features:
* Live viewer count and stream status (Live / Offline)
* The current viewer password, with buttons to rotate and copy it
* A public/private switch, and pending requests to approve or deny (see [Viewer access](#viewer-access))
* Connected viewers with their IP address and stream path, a kick button and a 🎲 button that re-rolls a guest's pony picture
* Pending requests and current viewers are virtualized, scrollable lists with a search box (matches the viewer's name, Discord account, or IP)
* Activity log of recent viewer connections and disconnections, opened in a popup from the header's log button
* Optional audio chime synthesized via Web Audio API on viewer join
* The header shows the live stream's path. When several paths are live at once (e.g. OBS on `desktop` and the browser panel on `browser`), it becomes a dropdown with each stream's viewer and pending counts, and the password, public/private switch, pending requests, viewers and activity below all follow the picked stream. Join/leave chimes still play for every stream
* Kicking, approving, denying and switching a stream between public and private take effect at once, both in the dock and for the viewers concerned
* Switching a stream with viewers to private asks what to do with them: approve them all so they keep watching, make them request access again, or kick them all (each gets the same timeout as a manual kick, see `DENIAL_TIMEOUTS`)

### Adding to OBS Studio

1. In OBS Studio, open **Docks** > **Custom Browser Docks...**
2. Set **Dock Name** to `Stream HUD` (or any name you prefer).
3. Set **URL** to `https://stream.example.com/dock` (or `http://localhost:8080/dock`).
4. Enter your `STREAMER_PASSWORD` on the login page that appears.
5. Dock the window anywhere in your OBS workspace.

## Browser streaming panel

For streaming without OBS (e.g. to avoid being locked into a single resolution/framerate for everything you capture), a self-contained streaming panel is available at `/stream`, gated the same way as `/dock` (`STREAMER_PASSWORD`, or bypassed entirely when `DISABLE_DOCK_AUTH=true`).

It uses the browser's native [`getDisplayMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) screen/window/tab picker to capture a source, then publishes it directly to MediaMTX over WebRTC using [WHIP](https://mediamtx.org/docs/features/webrtc), proxied through `/api/whip/<path>` the same way `/api/whep` proxies playback. The MediaMTX path it publishes to must be one already declared in `paths.yml` (see [Paths](../mediamtx/README.md#paths)); the built-in `paths.yml` ships with a `browser` path for this purpose, independent from whatever OBS publishes to `default`/`desktop`.

Available settings, adjustable per-stream and optionally saved for next time:
* **Path** - the MediaMTX path name to publish to, picked from a dropdown listing paths declared in `paths.yml` (or currently active); custom/undeclared path names cannot be selected or published to, since MediaMTX only grants publish/read permissions to paths configured there; viewers watch it at that same path
* **Preferred source** - desktop, application window, or browser tab (only pre-selects the browser's share picker; the final choice is still made there); when "Application window" + audio is picked, a Chrome-only `windowAudio: "window"` hint asks the browser to scope captured audio to that window alone instead of the whole desktop - support varies by browser/OS, so a warning is shown and "Entire desktop"/"Browser tab" remain the more reliable fallbacks
* **Fixed resolution** - optionally pin capture to a specific width/height instead of following the source's native resolution
* **Framerate**
* **Video bitrate and codec** (VP8/VP9/H.264/AV1, subject to browser support; defaults to H.264) - if H.264 ends up being negotiated (explicitly chosen, or picked automatically), the panel always prefers its Baseline profile, which cannot use B-frames, reducing encode/decode latency. There is no web API to request a specific hardware encoder (e.g. NVENC) directly - the browser always decides - but Chrome only hardware-accelerates H.264 broadly (VP8 has no hardware encoder path at all, VP9/AV1 support is limited and GPU/OS-dependent), so H.264 is the closest equivalent to OBS+NVENC at high bitrates; make sure hardware acceleration is enabled in your browser's settings too
* **Content hint** - hints the encoder to favor motion smoothness, per-frame detail, or text sharpness (`motion`/`detail`/`text`), or leave it to the browser's default
* **Degradation preference** - when bandwidth/CPU can't keep up, whether the encoder should drop resolution to keep the framerate smooth (`maintain-framerate`, the default - usually fixes stutter), drop framerate to keep resolution sharp (`maintain-resolution`), or balance both
* **Audio** - whether to include system/tab audio, and its target bitrate; if the browser/OS can't provide audio for the chosen source, the stream automatically falls back to video-only instead of failing to start. If audio capture fails with a "Could not start audio source" error, a virtual surround sound effect on your headphones/audio device is a common cause - try disabling it.

Saved settings go to the [database](#database).

Because everything runs in the browser, resolution and framerate are no longer forced to a single global setting like they are in OBS - the browser panel captures at whatever the source natively provides (or a fixed size you choose), independently from anything else running on the machine.

Under the hood, the panel also applies a few other WebRTC tuning options: `bundlePolicy: "max-bundle"` and a small ICE candidate pool for a faster initial connection, `maxFramerate`/`priority`/`networkPriority` on the video encoding, and disabled Opus DTX with in-band FEC enabled on the audio track.

## Live updates

Pages don't poll for changes; the server pushes them over [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events):

* The player and the "waiting for approval" screen share one stream per page (`/api/watch/<path>`). It carries whether the viewer may watch (or is waiting, kicked or denied, with the time left) and whether the stream is online, plus the viewer list and reactions. A kicked viewer is moved to the removal screen right away, an approved one straight into the stream, and the player connects as soon as the stream goes live.
* The dock has its own stream (`/api/dock/events`) with everything it shows.
* A waiting viewer's request lasts as long as their waiting screen is open: closing it takes them off the dock's pending list immediately.
* Stream state comes from the media server's [hooks](../mediamtx/README.md#hooks). In case one is missed, for example because of a wrong `HOOK_SECRET`, the web app also checks MediaMTX every 10 seconds while anyone is watching.

Proxies in front of the web app must not buffer responses for this to work. Responses carry `X-Accel-Buffering: no` for NGINX; other proxies (and Cloudflare) stream them as-is.

All of this state lives in the web app's memory and SQLite database, so run a single `mtxcord-web` container.

## Database

Viewer passwords, stream visibility, pending requests, approvals, kick/deny timeouts, guest identities, Discord message ids and saved `/stream` settings are stored in a small SQLite database, at `/data/sqlite/mtxcord.db` (override with `MTXCORD_DB_PATH`, which is only meant for tests and running outside Docker). Mount `/data` as a volume (already done in the provided `docker-compose.yaml`, mapped to `./config`, so the database ends up in `config/sqlite`) to persist it across restarts.

A database from before the rename (`discordmtx.db`) is deleted on startup and not migrated; to keep its data, stop the stack and rename it (and any `-wal`/`-shm` files next to it) to `config/sqlite/mtxcord.db` before starting the new version.

## Tests

Requires Node 26. Run everything from the `nextjs/` folder. There are three layers:

* **Unit** (`tests/unit`): the `lib` modules and pure client helpers.
* **Integration** (`tests/integration`): the API route handlers against an in-memory SQLite database, with MediaMTX, Discord and Derpibooru faked.
* **E2E** (`tests/e2e`): [Playwright](https://playwright.dev) on Chromium against a production build and a fake MediaMTX. Covers the critical paths: streamer login and password rotation, guest approval and denial, kicks, the stream going online and offline, and access guards.

```bash
npm ci
npm test                  # unit + integration
npm run test:unit
npm run test:integration
npm run test:watch
```

For the e2e tests, install the browser once with `npx playwright install chromium`, then run `npm run test:e2e`. It builds the app first and uses ports 3100 and 18889.

CI runs the unit and integration tests on every push and pull request, and the `mtxcord-web` image is only built when they pass. The e2e tests are local-only.
