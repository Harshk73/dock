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
| `web/js/compat.js` | The "will it work on my phone?" check shown before installing. |
| `web/js/recipes.js`, `workspace.js`, `assistant.js` | The per-app screens: recipes, the automatic options screen, file sharing, and Ask AI. |
| Google Drive | Backup only. The VM's disk is saved on the phone and, if you connect Drive, copied to a `Dock` folder there. Drive stores files; nothing runs on it. |

Installing from a link: Dock fetches the repo's README and manifest files, picks the
fastest working route (PyPI release, npm release, prebuilt Alpine package, agent-skills
folder, or a source build), shows the steps, and runs them with live output. If the
first route fails it falls back to building from source.

## "Will it work on my phone?"

Before anything is installed, Dock reads the repository's README and its setup files and
shows a verdict: **Should work**, **Might work** or **Won't work on a phone**, with the
reasons and the README lines that led to them. No AI is involved (`web/js/compat.js`).

It looks for: a ready-made Alpine Linux build of the project (looked up by the server in
Alpine's package index), releases on PyPI or npm, and things a phone's emulated Linux
can't provide — a GPU, gigabytes of memory, Docker, a real web browser, desktop or phone
app projects, runtimes with no 32-bit build (Deno, Bun, .NET), local AI models, Rust or
C code that would need compiling, and paid API keys the tool depends on.

On 38 well-known repositories the verdicts matched what actually works, but it is a set of
rules reading prose, so it can still be wrong; "Install anyway" is always available.

## Using an installed app

Tapping an app opens its **workspace**, which has the same three tabs for every tool:

- **Use** — a tap-driven screen, so nobody has to type commands. Where it comes from:
  - a hand-written *recipe* (`web/js/recipes.js`) for tools that have one. Two ship now:
    **yt-dlp** (search YouTube or paste a link from any supported site, see the video,
    then Save video / audio / subtitles / thumbnail) and **FFmpeg** (pick a video from
    the phone, then Trim / Extract the sound / Remove the sound / Make a GIF / Make it
    smaller);
  - for every other command-line tool, a screen generated from the tool's own `--help`:
    each option becomes a switch or a text field, plus a file picker and a Run button;
  - for skill repositories, the list of skills; for web apps, a Start button.
- **Files** — a folder shared between the phone and the tools (`/root/Files`): add files
  from the phone, save results back through the share sheet, delete.
- **Ask AI** — describe what you want in plain words and Claude runs the tool or follows
  the skill for you inside Dock's Linux, showing each command. This is what makes agent
  skills usable on a phone. It needs your own Anthropic API key (Settings → Ask AI),
  which is stored on the phone and sent only to Anthropic; usage is billed to that key.
  It uses `claude-opus-5-5` and lets the API fall back to another model if a request is
  declined.

Adding a recipe for another tool is a small data entry in `recipes.js`: which websites
it works with, whether it takes a link or a file, and a list of actions that each build
one shell command from a few form fields.

### About the YouTube screen

A web app is not allowed to display youtube.com inside itself (YouTube forbids being
embedded as a whole site). So Dock shows its own view: search results come from yt-dlp,
and the video plays in YouTube's official embedded player. A native iOS build could show
the real site with Dock's buttons over it.

## Install it on your iPhone

Dock is not in the App Store. You put it online once (free), then add it to your home
screen from Safari.

1. **Put it online.** Click the button below, sign in to Render with GitHub, and press
   **Apply**. Render builds Dock from this repository and gives you an address such as
   `https://dock-xxxx.onrender.com`.

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Harshk73/dock)

   (Or in Render: **New +** → **Blueprint** → pick this repository. `render.yaml` holds
   the settings.) On the free plan the server sleeps when unused, so the first visit after
   a break takes about a minute.
2. **Add it to the phone.** Open that address in **Safari**, tap **Share** →
   **Add to Home Screen** → **Add**. It must be Safari: other iPhone browsers can't add
   installable web apps.
3. **Open Dock** from the new icon. "Linux ready" appears after a short wait (longer the
   first time, while about 90 MB downloads). Try **ripgrep** from the suggestions first:
   it installs in seconds.

Anywhere else that runs Docker works too: `Dockerfile` is included and listens on
`$PORT` (8080). iPhones need the address to be **HTTPS**.

To try it on a computer instead:

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:8080.

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

Works: tools that install with `pip`, `npm` or Alpine's `apk`; well-known C programs that
Alpine packages (FFmpeg, ImageMagick); agent-skill repositories; simple web apps that
serve plain HTTP (shown in an in-app preview).

Doesn't: anything needing Docker, a GPU, a desktop window, a desktop browser engine
(Puppeteer, Playwright, Remotion — which rules out browser-rendered video tools such as
OpenFilm), 64-bit-only binaries, or heavy compilation; web apps that depend on WebSockets
(Streamlit, Gradio) load but don't update.

Everything is emulated, so it is slow. Measured in desktop Chrome on a development
machine (a phone will be slower):

| Task | Time |
| --- | --- |
| Linux boots | 11–15 s |
| Install ripgrep (Alpine) / FFmpeg (Alpine) / yt-dlp (PyPI) / cowsay (npm) | 15 s / 50 s / 1–2.5 min / 1.5–2 min |
| yt-dlp search or reading a link | about 20 s |
| Trim a video or extract its sound (no re-encoding) | about 1 s |
| Re-encode 4 s of 360p video to 240p | 17 s |
| Copy a file phone → Linux / Linux → phone | 1.5 MB/s / 6 MB/s |

Re-encoding video (resize, compress, filters, burned-in captions) is impractical beyond
short, small clips. Real video editing needs the tools to run on a server instead; the
app's Linux connection (`web/js/machine.js`, `agent.js`) is the piece to swap for that.

## Tested and not tested

Tested here, in a phone-sized Chromium:

- link → plan → install → run for yt-dlp, cowsay, ripgrep, FFmpeg and `anthropics/skills`
- the disk surviving a page reload; uninstall; the in-app web preview
- yt-dlp workspace: a live YouTube search, the video page with its actions, downloading a
  clip from a pasted link and saving it to the "phone" byte-for-byte
- FFmpeg workspace: uploading a video and trimming it
- the options screen generated from `rg --help`, run on an uploaded file
- Ask AI: the full loop (commands run in Linux, results returned, answer shown) against a
  local stand-in for the Anthropic API (`tests/mock-anthropic.mjs`)
- Drive backup, incremental backup, restore onto a second "phone", and replacing a stale
  backup, all against a local stand-in for Google's API (`tests/mock-google.mjs`)

Not tested:

- **A real iPhone or Safari.** Only Chromium was available. Memory limits on iOS are the
  main risk; the VM defaults to 384 MB on phones and can be lowered in Settings.
- **Downloading from YouTube itself.** Search and reading video details worked; the
  build machine could not reach YouTube's media servers, so the download step was tested
  with a clip from a local server. YouTube also often refuses downloads coming from
  data-centre addresses, and the relay's address is what YouTube sees, so this may need a
  relay on a home or residential connection.
- **Ask AI with a real Anthropic key**, and **real Google sign-in and Drive**.
- **The native iOS wrapper** in `ios-wrapper/` — see its README.

## Tests

```bash
npm test
```

Offline unit tests, plus the Ask AI loop against a mock API. The files `tests/smoke-*.mjs`,
`tests/e2e-install.mjs` and `tests/browser-*.mjs` boot the real VM (the browser ones need
Playwright with Chromium).

## Rebuilding the Linux image

```bash
sudo npm run build:image
```

Needs Linux, root, curl, Python 3 and `mke2fs`. Add packages in `image/build-rootfs.sh`;
files in `image/overlay/` are copied over the root filesystem. A rebuilt image has a new
version, and phones holding a disk made from the old one are asked to erase it.

## Third-party software

v86 (BSD-2-Clause), xterm.js (MIT), Anthropic SDK (MIT), Alpine Linux packages under their own licences,
SeaBIOS (LGPLv3) in `web/vm/bios/`.
