# basic-antigravity-usage

Minimal local quota checker for Antigravity.

## What it does

This script connects to the Antigravity language server running on your machine and prints:
- Current user email
- Used vs monthly prompt credits
- Per-model quota reset/remaining info (chat models)

## Requirements

- Windows
- Node.js 18+
- Antigravity IDE running and logged in

## Run

```bash
npm start
```

Or:

```bash
node index.js
```

## How it works

`index.js` runs this pipeline:

1. Find Antigravity process
- Runs PowerShell query (`Get-CimInstance Win32_Process`) and filters processes containing `antigravity`.
- Reads process command line and extracts `--csrf_token`.

2. Find local listening ports for that process
- Runs `netstat -ano`.
- Matches rows where:
  - PID = Antigravity PID
  - state = `LISTENING`
  - address starts with `127.0.0.1`

3. Probe Antigravity local API
- Tries each discovered port with HTTPS POST to:
  - `/exa.language_server_pb.LanguageServerService/GetUserStatus`
- Sends required headers, including `X-Codeium-Csrf-Token`.
- Uses a 5s timeout.

4. Parse and print usage
- Reads `userStatus` from API response.
- Prints account email and plan credit usage.
- Reads model quota config and hides autocomplete/embedding entries.
- Prints remaining percentage and reset time for each displayed model.

## Output example

```text
Antigravity quota usage
----------------------------------------
User: you@example.com
Credits: 49500 / 50000 used (99%)

Model quotas:
- Gemini 3 Pro (High): remaining 80%, resets 2/13/2026, 6:57:58 PM
```

## Notes

- No external dependencies are required.
- This is a local-only check (loopback `127.0.0.1`).
- If Antigravity is closed or token/ports are unavailable, the script exits with an error message.
