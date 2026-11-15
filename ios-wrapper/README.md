# Native iOS shell (not yet built or tested)

Dock already installs as an app from Safari (Share → Add to Home Screen): it gets its
own icon, launches full-screen with no browser bars, and keeps its own storage. That is
the tested path.

This folder is the starting point for a real `.ipa` built with Capacitor. It was written
on Linux, where iOS apps cannot be compiled, so **it has never been built or run**. Treat
it as a scaffold.

## What you need

- A Mac with Xcode
- An Apple ID (a free one runs the app on your own iPhone for 7 days at a time; the paid
  Apple Developer Program is needed for TestFlight or the App Store)
- Dock deployed somewhere over HTTPS (see the main README)

## Steps

1. Put your deployed address in `capacitor.config.json` → `server.url`.
2. In this folder run:

   ```bash
   npm install
   ```

   ```bash
   npx cap add ios
   ```

   ```bash
   npx cap open ios
   ```

3. In Xcode, open `App/App/Info.plist` and add the key `WKAppBoundDomains` (an array)
   containing your Dock hostname. Service workers, which Dock uses for app previews and
   offline start-up, only run inside a native web view for app-bound domains.
4. Pick your team under Signing & Capabilities, select your iPhone, press Run.

## Known gaps to solve before this matches the home-screen app

- **Google sign-in.** Google refuses OAuth inside embedded web views. Drive backup needs a
  native sign-in (for example `ASWebAuthenticationSession` through a Capacitor plugin)
  that hands the access token to the page.
- **Share sheet.** Receiving a GitHub link from Safari's share sheet needs a Share
  Extension target that opens the app with `?repo=<link>`; the web app already handles
  that parameter.
- **App Store review.** Apps that download and run code are reviewed strictly (guideline
  2.5.2). Emulator-based shells such as iSH have been approved, but approval is not
  guaranteed.
