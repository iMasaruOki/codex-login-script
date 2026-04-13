# Codex Remote Login Script

`remote-codex-login.sh` wraps `codex login` and drives the ChatGPT login page
through Chromium running on the remote host.

The browser backend stays on the remote machine, so the OAuth callback to
`http://localhost:PORT/auth/callback` also lands on the remote machine.

If `xvfb-run` is available, the script prefers a normal Chromium session inside
Xvfb. Otherwise it falls back to headless Chromium.

## Requirements

- `codex`
- `google-chrome` or `chromium`
- `xvfb-run`

For the recommended OCR/X11 mode, install these as well:

- `xdotool`
- `imagemagick`
- `tesseract-ocr`

On Ubuntu, a typical setup is:

```bash
sudo apt-get install -y xvfb xdotool imagemagick tesseract-ocr
```

## Usage

```bash
./remote-codex-login.sh
```

The script will:

1. start `codex login`
2. extract the ChatGPT OAuth URL that Codex prints
3. launch Chromium on the remote host
4. open the login page in that remote browser
5. show visible text and interactive controls in the terminal
6. let you fill fields and click buttons with terminal commands

When OCR/X11 mode is active, the helper also forces the auth URL back into the
browser address bar during startup so Chrome update or restore tabs do not block
the login page.

## Terminal commands

- `click N`: click control `N`
- `fill N`: type normal text into control `N`
- `secret N`: type hidden text into control `N`
- `choose N`: pick a value for select control `N`
- `enter`: submit the focused field or form
- `back`: go back
- `open URL`: navigate to a specific URL
- `wait`: wait briefly and refresh the page snapshot
- `show`: refresh the page snapshot immediately
- `quit`: stop the helper

## Notes

- This is still browser automation, not a pure text-only login protocol.
- With `xvfb-run`, the browser runs in a virtual display instead of headless mode.
- OCR/X11 mode is only enabled when `xvfb-run`, `xdotool`, `imagemagick`, and
  `tesseract-ocr` are all available.
- Password and OTP style flows should work better than passkeys.
- CAPTCHA or future login UI changes may still break automation.
- You can override the browser binary with `BROWSER_BIN=/path/to/browser`.
