# Claude Config Dashboard contract

## Doors it offers

| Door | What it answers |
|---|---|
| GET / (127.0.0.1:7373) | The dashboard page |
| GET /api/data | The live scan of the configuration folder, secrets masked |
| GET /api/doc?id=N | One allow-listed file's contents, secrets masked |

## Data it owns

| Table / bucket / file | What is in it |
|---|---|
| (none) | Read-only: it keeps no data and never writes to the configuration it shows |

## Settings and secrets it needs

Named here, never valued.

| Name | What it is |
|---|---|
| PORT | Port to listen on (default 7373) |
| CLAUDE_DIR | Configuration folder to show (default ~/.claude) |
| CLAUDE_MEMORY_DIR | Memory folder to show (default: found automatically) |
| CONFIG_FILE | Optional panels and branding file |
| WORKSPACE_DIR | Base folder for relative paths in the config file |
| CLAIMS_DIR | Turns on the Sessions board for this folder |
