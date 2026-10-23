# Local settings

`config.json` stores the GitHub user and Notion data source ID only.
Environment variables override these values (including GITHUB_REPOSITORY_OWNER).
Run the CLI from the project directory containing `.stars-to-notion/`.

Supply GITHUB_TOKEN and NOTION_TOKEN through your shell or secret manager,
or copy `.env.example` to `.env` in the project root and fill in the tokens.
The CLI loads the project root's `.env` automatically when syncing.
Use `--env-file .stars-to-notion/.env` to read a file in this settings directory.
Existing shell environment variables take priority. Never add credentials to config.json.
Stop other sync processes targeting the same Notion data source before running.
