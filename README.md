# Discord Commit Webhook Notifier

A lightweight GitHub Action for sending Discord notifications when repository activity occurs.

## What it supports

- Push notifications
- Pull request notifications
- Release notifications
- Branch filtering
- Retry handling for temporary Discord webhook failures
- Compact commit and file summaries

## Example workflow

```yaml
name: Notify Discord

on:
  push:
    branches:
      - main
      - release/**
  pull_request:
    types: [closed]
  release:
    types: [published]

jobs:
  discord:
    runs-on: ubuntu-latest
    steps:
      - name: Send Discord notification
        uses: AethosxAI/-X@v1
        with:
          webhook_url: ${{ secrets.DISCORD_WEBHOOK_URL }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          event_types: push,pull_request,release
          branch_filter: main,release/**
          max_commits: 8
          max_files_per_commit: 8
          include_changed_files: true
          username: GitHub Actions
          avatar_url: https://example.com/avatar.png
          color: 00B894
```

## Inputs

- webhook_url: required Discord webhook URL
- github_token: optional GitHub token for metadata lookup
- event_types: push,pull_request,release
- branch_filter: optional branch filter
- max_commits: maximum number of commit subjects to show
- max_files_per_commit: maximum number of file paths to show in a summary
- include_changed_files: whether to include changed files
- username: custom Discord display name
- avatar_url: custom Discord avatar URL
- color: embed border color in hex
- retry_count: retries for transient webhook errors
- retry_backoff_ms: delay between retries
- fail_on_webhook_error: fail the workflow on Discord send errors
- message_template: optional template string using {{repo}}, {{branch}}, {{author}}, {{commit_count}}

## Outputs

- status
- event_type
- repository
- branch
- commit_count
- sent

## Notes

This action is intentionally compact and reliable for public GitHub Actions usage. It keeps webhook payloads small and safe while still providing useful notifications for teams.
