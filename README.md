# MTXcord

[![Docker](https://img.shields.io/badge/Docker-required-blue?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Made for personal streaming with whatever quality and framerate you want - no need to pay for Nitro just to get readable text and bearable stream quality.

A small, self-hosted Docker Compose stack for direct, no-transcode WebRTC streaming to your friends. Bitrate, resolution and framerate are fully controlled by whatever you stream from (OBS or your browser), and you decide who gets to watch.

## Features

* Low-latency WebRTC streaming (WHIP in, WHEP out) through [MediaMTX](https://github.com/bluenviron/mediamtx), with no transcoding
* Stream from OBS, or straight from the browser with the `/stream` panel - no OBS required
* Viewers sign in with Discord, or as guests with a per-stream viewer password
* Private streams by default: you approve each viewer, or switch a stream to public so anyone signed in can watch
* Kick or deny viewers, with a timeout that grows on each repeat
* Anonymous pony names and Derpibooru avatars for guests
* A streamer dashboard (`/dock`) that fits in OBS as a Custom Browser Dock: viewers, pending requests, password, public/private switch, activity log and join chimes
* A Discord webhook message that's edited in place when you go online or offline, instead of a new message every stream
* Live emoji reactions that float over the player for every viewer (buttons or keys `1`-`8`)
* A "who's watching" overlay (button or `V`), and `M`/`F` shortcuts for mute and fullscreen
* Connection warnings for viewers (packet loss, stalls, high latency, freezes, dropped frames, going offline) plus a signal indicator with live stats
* An accent colour picker, either custom or taken from the viewer's avatar
* Everything updates live: kicks, approvals, the stream going on/offline, viewers joining and leaving reach every open page within milliseconds

## How it fits together

```text
OBS / browser panel ──WHIP──▶ mtxcord-media (MediaMTX) ──WebRTC (UDP 8189)──▶ viewers' browsers
                                     │  ▲                                          │
                              hooks  │  │ WHEP signaling, control API              │ login, player, dock
                                     ▼  │                                          ▼
                              mtxcord-web (Next.js) ◀──────────────────────────────┘
```

* **[mtxcord-media](mediamtx/README.md)** runs MediaMTX: it takes your stream in and sends the video to viewers. Its hooks tell the web app when a stream goes online or offline and when viewers come and go.
* **[mtxcord-web](nextjs/README.md)** is the Next.js app viewers and you actually open: login, the player, `/dock` and `/stream`. It checks each viewer's access before passing their WebRTC signaling on to MediaMTX; the video itself goes straight from MediaMTX to the browser.

## Quick start

Requirements: Docker with Docker Compose, a domain pointing to the server, and a reverse proxy for HTTPS (see [HTTPS](#https)).

Clone the repository:

```bash
git clone https://github.com/michalhubert/MTXcord.git
cd MTXcord
```

Create a `.env` file:

```env
# Required. Lets OBS publish, and signs you in to /dock; use a long, random one
STREAMER_PASSWORD=
# Required; generate one with: openssl rand -hex 32
NEXTAUTH_SECRET=

PLAYER_DOMAIN=stream.example.com
NEXTAUTH_URL=https://stream.example.com
WEBRTC_ADDITIONAL_HOSTS=192.168.1.100,203.0.113.10
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Optional: lets viewers sign in with Discord
#DISCORD_CLIENT_ID=
#DISCORD_CLIENT_SECRET=
```

Start the stack:

```bash
docker compose up -d
```

Then:

1. Point OBS at `http://<server-address>:8889/default/whip` with the Bearer Token `streamer:<STREAMER_PASSWORD>` (see [Publishing with OBS Studio](mediamtx/README.md#publishing-with-obs-studio)), or open `/stream` to stream from the browser.
2. Open `/dock`, sign in with `STREAMER_PASSWORD`, and generate a viewer password with the rotate button if you want guests (see [Viewer access](nextjs/README.md#viewer-access)).
3. Share `https://stream.example.com/default` with your viewers.

Check the logs with `docker compose logs -f` and stop the stack with `docker compose down`.

## Configuration

Everything is configured through the `.env` file next to `docker-compose.yaml`. Each service's README covers its own variables and features:

* **[Media server](mediamtx/README.md)**: OBS publishing, stream paths (`paths.yml`), ports, WebRTC hosts, trusted proxies, UDP tuning and hooks
* **[Web app](nextjs/README.md)**: sign-in and viewer access, guest names and avatars, Discord webhooks, client IPs, the dock, the browser panel, live updates and the database

### Shared variables

These are read by both services:

| Variable            | Description                                       |
| ------------------- | -------------------------------------------------- |
| `STREAMER_PASSWORD` | Required. Password of MediaMTX's `streamer` user (used by OBS and the web app) and of the `/dock` and `/stream` login |
| `HOOK_SECRET`       | Shared secret the media server's hooks send to the web app (defaults to `NEXTAUTH_SECRET`; must be the same on both services) |
| `PLAYER_DOMAIN`     | Domain used for the player link in Discord notifications |

## HTTPS

The web app handles authentication (Discord OAuth, per-stream viewer password and streamer password) and the WHEP signaling proxy, but not TLS.

For a public deployment, put it behind a TLS-enabled reverse proxy such as Caddy, Traefik, or Cloudflare, and set `CLIENT_IP_HEADER` to match it (see [Client IPs](nextjs/README.md#client-ips)).

Keep in mind that HTTPS proxying and WebRTC are separate connections. Cloudflare can proxy the HTTP/HTTPS side normally, while WebRTC still needs its UDP path to be reachable (see [`WEBRTC_ADDITIONAL_HOSTS`](mediamtx/README.md#webrtc_additional_hosts)).

## Development

For local development/testing, use the compose file in `dev/`, which builds the images from source instead of pulling the published ones:

```bash
cd dev
docker compose up -d --build
```

It reads the same environment variables via a `.env` file placed in the `dev/` directory.

To run the web app's tests, see the [Tests section](nextjs/README.md#tests) of its README.

## Project structure

```text
.
├── .github/              # CI: builds and pushes both images
├── dev/                  # compose file that builds from source
├── mediamtx/             # mtxcord-media: MediaMTX config, entrypoint and hooks
├── nextjs/               # mtxcord-web: the Next.js app
└── docker-compose.yaml
```

## License

[MIT](LICENSE)

## Note

Built with help from Claude Code.
