# Codex Remote Login Script

`remote-codex-login.sh` wraps `codex login --device-auth` so you can complete
ChatGPT authentication from a remote or headless console.

## Usage

```bash
./remote-codex-login.sh
```

The script will:

1. show the current `codex login` status
2. ask whether to start device login
3. run `codex login --device-auth`
4. show login status again after authentication finishes

During login, open the displayed URL in a browser on your local machine,
sign in, and choose a workspace if ChatGPT asks for one.

## Options

```bash
./remote-codex-login.sh --yes
./remote-codex-login.sh --force
```

- `--yes`: skip the initial confirmation prompt
- `--force`: start login even if Codex is already logged in
