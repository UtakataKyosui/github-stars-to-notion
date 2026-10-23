# Local settings

`config.json` stores the GitHub user and Notion data source ID only.
Environment variables override these values (including GITHUB_REPOSITORY_OWNER).
Run the CLI from the project directory containing `.stars-to-notion/`.

Supply GITHUB_TOKEN and NOTION_TOKEN through your shell or secret manager.
The CLI does not load `.env` files. Never add credentials to config.json.
Stop other sync processes targeting the same Notion data source before running.
