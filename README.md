# Dock

Paste a GitHub link on your phone; Dock reads the repository, works out how to install
it, and runs it in a private Linux that lives inside the app. No commands to copy.

Dock is a web app you add to the iPhone home screen. It then opens full-screen with its
own icon, like any other app.

## How it works

| Part | What it does |
| --- | --- |
| `web/` | The app. Runs a 32-bit Alpine Linux in an x86 emulator (v86, WebAssembly) on the phone. |
| `web/vm/` | The Linux system image, split into 1 MB pieces that load on demand (74 MB in total). |
| `server/relay.mjs` | Serves the app and relays the Linux VM's network traffic. A browser can't open raw internet connections, so this small server is required. |
| Google Drive | Backup only. The VM's disk is saved on the phone and, if you connect Drive, copied to a `Dock` folder there. Drive stores files; nothing runs on it. |

Installing from a link: Dock fetches the repo's README and manifest files, picks the
fastest working route (PyPI release, npm release, prebuilt Alpine package, agent-skills
folder, or a source build), shows the steps, and runs them with live output. If the
first route fails it falls back to building from source.

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8080. To use it on an iPhone it must be served over **HTTPS** (iOS
requires that for installable apps and their storage), so deploy it:

- **Render**: push this folder to a GitHub repository, then New → Blueprint in Render and
  pick the repo (`render.yaml` is included).
- **Anywhere Docker runs**: `Dockerfile` is included; it listens on `$PORT` (8080).

Then on the iPhone: open the address in Safari → Share → **Add to Home Screen**.

### Settings to change when you deploy

- **Relay token.** Out of the box the relay path is `/r/open`, which anyone who knows your
  address could use as a proxy. Set the `DOCK_TOKEN` environment variable to a long random
  string and put `https://your-host/r/<token>` in `web/config.js` (`relayBase`) or in the
  app under Settings → Network relay.
- **Google Drive backup.** Create an OAuth client ID (Google Cloud console → APIs &
  Services → Credentials → Create credentials → OAuth client ID → Web application), add
  your Dock address as both an authorized JavaScript origin and an authorized redirect
  URI, enable the Google Drive API, and put the client ID in `web/config.js`
  (`googleClientId`) or in Settings. While the OAuth app is in "Testing" mode, add your
  own Google account as a test user.

## What works and what doesn't

Works: tools that install with `pip`, `npm` or Alpine's `apk`; agent-skill repositories;
simple web apps that serve plain HTTP (shown in an in-app preview).

Doesn't: anything needing Docker, a GPU, a desktop window, 64-bit-only binaries, or heavy
compilation; web apps that depend on WebSockets (Streamlit, Gradio) load but don't update.

Everything is emulated, so it is slow. Measured in desktop Chrome on a development
machine: Linux boots in 11–15 s, `cowsay` from npm installs in about 2 minutes, `yt-dlp`
from PyPI in about 2.5 minutes, `ripgrep` from Alpine in about 15 seconds. A phone will be
slower.

## Tested and not tested

Tested here, in a phone-sized Chromium:

- link → plan → install → run for yt-dlp, cowsay, ripgrep and `anthropics/skills`
- the disk surviving a page reload; uninstall; the in-app web preview
- Drive backup, incremental backup, restore onto a second "phone", and replacing a stale
  backup, all against a local stand-in for Google's API (`tests/mock-google.mjs`)

Not tested:

- **A real iPhone or Safari.** Only Chromium was available. Memory limits on iOS are the
  main risk; the VM defaults to 384 MB on phones and can be lowered in Settings.
- **Real Google sign-in and the real Drive API** (needs your OAuth client ID).
- **The native iOS wrapper** in `ios-wrapper/` — see its README.

## Tests

```bash
npm test
```

Offline unit tests. The files `tests/smoke-*.mjs`, `tests/e2e-install.mjs` and
`tests/browser-*.mjs` boot the real VM (the browser ones need Playwright with Chromium).

## Rebuilding the Linux image

```bash
sudo npm run build:image
```

Needs Linux, root, curl, Python 3 and `mke2fs`. Add packages in `image/build-rootfs.sh`;
files in `image/overlay/` are copied over the root filesystem. A rebuilt image has a new
version, and phones holding a disk made from the old one are asked to erase it.

## Third-party software

v86 (BSD-2-Clause), xterm.js (MIT), Alpine Linux packages under their own licences,
SeaBIOS (LGPLv3) in `web/vm/bios/`.
