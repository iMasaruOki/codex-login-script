# Codex Remote Login Script

`remote-codex-login.sh` wraps regular `codex login` for remote console use.

The normal browser login flow starts a callback server on the remote host such
as `http://localhost:1455/auth/callback`. If you open the login URL on your
local machine, the browser tries to redirect to your own localhost and the
final step does not reach the remote host automatically.

This script solves that by:

1. starting `codex login`
2. extracting and printing the ChatGPT login URL
3. asking you to finish login in your local browser
4. asking you to paste the final `http://localhost:PORT/auth/callback?...` URL
5. replaying that callback against the remote host's localhost port

## Usage

```bash
./remote-codex-login.sh
```

After the script prints the login URL:

1. open it in a browser on your local machine
2. sign in with your account
3. complete password or passkey flow
4. choose a workspace if ChatGPT asks
5. copy the final failed `localhost` URL from the browser address bar
6. paste that URL back into the script

## Options

```bash
./remote-codex-login.sh --yes
./remote-codex-login.sh --force
```

- `--yes`: skip the initial confirmation prompt
- `--force`: start login even if Codex is already logged in
