const fs = require("fs");
const core = require("@actions/core");

function parseInputList(raw) {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeColor(value) {
  const color = String(value || "00B894").trim();
  if (/^[0-9a-fA-F]{6}$/.test(color)) return parseInt(color, 16);
  if (/^[0-9a-fA-F]{3}$/.test(color)) {
    const expanded = color.split("").map((char) => char + char).join("");
    return parseInt(expanded, 16);
  }
  return parseInt("00B894", 16);
}

function matchesBranchFilter(branch, rawFilter) {
  const filters = parseInputList(rawFilter);
  if (!filters.length) return true;

  const target = String(branch || "").replace(/^refs\/heads\//, "");
  return filters.some((pattern) => {
    if (pattern === target) return true;
    if (pattern.endsWith("*")) {
      return target.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

function safeText(value, fallback = "N/A") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).slice(0, 1800) || fallback;
}

function buildDescriptionFromTemplate(template, data) {
  if (!template) return data.defaultDescription || "";

  try {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = data[key];
      return value === undefined || value === null ? "" : String(value);
    });
  } catch {
    return data.defaultDescription || "";
  }
}

function getBranchName(ref) {
  if (!ref) return "unknown";
  return String(ref).replace(/^refs\/heads\//, "");
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "discord-commit-webhook-notifier",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function sendDiscordWebhook(url, payload, retryCount, retryBackoffMs) {
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "discord-commit-webhook-notifier"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return { ok: true, status: response.status };
      }

      const text = await response.text();
      const status = response.status;

      if ((status === 429 || status >= 500) && attempt <= retryCount) {
        core.warning(`Discord webhook failed with ${status}; retrying (${attempt}/${retryCount})...`);
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs * attempt));
        continue;
      }

      throw new Error(`Discord webhook failed (${status}): ${text}`);
    } catch (error) {
      lastError = error;
      if (attempt <= retryCount) {
        core.warning(`Webhook retry (${attempt}/${retryCount}) after error: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs * attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Unknown Discord webhook failure");
}

function buildCommitSummary(commits, maxCommits) {
  if (!Array.isArray(commits) || commits.length === 0) return "No commits available";

  return commits
    .slice(0, maxCommits)
    .map((commit) => {
      const message = (commit.message || "").split("\n")[0].trim() || "Untitled commit";
      const author = commit.author && commit.author.login
        ? commit.author.login
        : (commit.committer && commit.committer.name ? commit.committer.name : "Unknown");
      return `• ${message} (${author})`;
    })
    .join("\n");
}

function buildChangedFilesSummary(files, maxFiles) {
  if (!Array.isArray(files) || files.length === 0) return "No file details available";

  const visible = files.slice(0, maxFiles);
  const extra = files.length - visible.length;
  const text = visible.map((item) => item.filename || item).join("\n");
  return extra > 0 ? `${text}\n+ ${extra} more` : text;
}

async function resolvePushFiles(repoFullName, before, after, token) {
  if (!repoFullName || !before || !after || before === "0000000000000000000000000000000000000000") {
    return [];
  }

  try {
    const data = await fetchJson(`https://api.github.com/repos/${repoFullName}/compare/${before}...${after}`, token);
    return Array.isArray(data.files) ? data.files : [];
  } catch (error) {
    core.warning(`Could not resolve changed files: ${error.message}`);
    return [];
  }
}

function buildPushPayload(event, branchFilter, options) {
  const repo = event.repository || {};
  const refName = getBranchName(event.ref || "unknown");

  if (!matchesBranchFilter(refName, branchFilter)) {
    return null;
  }

  const commits = Array.isArray(event.commits) ? event.commits : [];
  const fileList = Array.isArray(event.files) ? event.files : [];
  const compareUrl = event.compare || `${repo.html_url || "https://github.com"}/commits/${event.ref || ""}`;
  const summary = buildCommitSummary(commits, Number(options.maxCommits));
  const changedFiles = options.includeChangedFiles
    ? buildChangedFilesSummary(fileList, Number(options.maxFilesPerCommit))
    : "Hidden";

  const defaultDescription = `Push to ${refName} by ${event.pusher?.name || "unknown user"}`;
  const description = buildDescriptionFromTemplate(options.messageTemplate, {
    defaultDescription,
    repo: repo.full_name || repo.name || "repository",
    branch: refName,
    author: event.pusher?.name || "unknown",
    commit_count: commits.length,
    defaultDescription
  }) || defaultDescription;

  return {
    username: options.username,
    avatar_url: options.avatarUrl || undefined,
    embeds: [
      {
        title: `${refName} • ${commits.length} commit${commits.length === 1 ? "" : "s"}`,
        url: compareUrl,
        description,
        color: normalizeColor(options.color),
        timestamp: new Date().toISOString(),
        fields: [
          { name: "Repository", value: safeText(repo.full_name || repo.name || "Unknown"), inline: true },
          { name: "Branch", value: safeText(refName), inline: true },
          { name: "Commits", value: safeText(summary, "No commit summary"), inline: false },
          ...(options.includeChangedFiles
            ? [{ name: "Changed files", value: safeText(changedFiles, "None"), inline: false }]
            : [])
        ]
      }
    ]
  };
}

function buildPullRequestPayload(event, branchFilter, options) {
  const pr = event.pull_request;
  const repo = event.repository || {};
  const branch = pr?.head?.ref || "unknown";

  if (!matchesBranchFilter(branch, branchFilter)) return null;

  const actionName = event.action || "updated";
  const merged = Boolean(pr?.merged);
  const notify = options.notifyMergedOnly ? merged : true;

  if (!notify && !merged && actionName !== "closed") {
    return null;
  }

  const title = `PR #${pr.number}: ${pr.title || "Untitled PR"}`;
  const description = merged
    ? `Merged by ${pr.merged_by?.login || "unknown"}`
    : `Pull request ${actionName}`;

  return {
    username: options.username,
    avatar_url: options.avatarUrl || undefined,
    embeds: [
      {
        title,
        url: pr.html_url || repo.html_url || "https://github.com",
        description,
        color: normalizeColor(options.color),
        timestamp: new Date().toISOString(),
        fields: [
          { name: "Repository", value: safeText(repo.full_name || repo.name || "Unknown"), inline: true },
          { name: "Branch", value: safeText(branch), inline: true },
          { name: "State", value: safeText(merged ? "Merged" : actionName), inline: true },
          { name: "Author", value: safeText(pr.user?.login || "Unknown"), inline: true }
        ]
      }
    ]
  };
}

function buildReleasePayload(event, branchFilter, options) {
  const release = event.release;
  const repo = event.repository || {};
  const branch = getBranchName(event.release?.target_commitish || "main");

  if (!matchesBranchFilter(branch, branchFilter)) return null;

  const title = `Release ${release.tag_name || "unknown"}`;
  const description = release.body ? release.body.slice(0, 500) : "New release published";

  return {
    username: options.username,
    avatar_url: options.avatarUrl || undefined,
    embeds: [
      {
        title,
        url: release.html_url || repo.html_url || "https://github.com",
        description,
        color: normalizeColor(options.color),
        timestamp: new Date().toISOString(),
        fields: [
          { name: "Repository", value: safeText(repo.full_name || repo.name || "Unknown"), inline: true },
          { name: "Tag", value: safeText(release.tag_name || "Unknown"), inline: true },
          { name: "Author", value: safeText(release.author?.login || "Unknown"), inline: true },
          { name: "Pre-release", value: safeText(String(Boolean(release.prerelease))), inline: true },
          { name: "Draft", value: safeText(String(Boolean(release.draft))), inline: true }
        ]
      }
    ]
  };
}

async function run() {
  try {
    const webhookUrl = core.getInput("webhook_url", { required: true });
    const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN || "";
    const eventTypes = parseInputList(core.getInput("event_types") || "push,pull_request,release");
    const branchFilter = core.getInput("branch_filter") || "";
    const maxCommits = Number(core.getInput("max_commits") || 8);
    const maxFilesPerCommit = Number(core.getInput("max_files_per_commit") || 8);
    const includeChangedFiles = core.getBooleanInput("include_changed_files") || false;
    const username = core.getInput("username") || "GitHub Actions";
    const avatarUrl = core.getInput("avatar_url") || "";
    const messageTemplate = core.getInput("message_template") || "";
    const color = core.getInput("color") || "00B894";
    const retryCount = Number(core.getInput("retry_count") || 3);
    const retryBackoffMs = Number(core.getInput("retry_backoff_ms") || 1000);
    const failOnWebhookError = core.getBooleanInput("fail_on_webhook_error") || false;

    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error("GITHUB_EVENT_PATH is not set");
    }

    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const eventName = process.env.GITHUB_EVENT_NAME || "push";
    const repoFullName = event.repository?.full_name || "unknown";

    const options = {
      maxCommits,
      maxFilesPerCommit,
      includeChangedFiles,
      username,
      avatarUrl,
      color,
      messageTemplate,
      notifyMergedOnly: false
    };

    let payload = null;
    let finalEventType = eventName;
    let branchName = "unknown";

    if (eventName === "push" && eventTypes.includes("push")) {
      branchName = getBranchName(event.ref || "unknown");
      const fileList = await resolvePushFiles(repoFullName, event.before, event.after, githubToken);
      payload = buildPushPayload({ ...event, files: fileList }, branchFilter, options);
    } else if (eventName === "pull_request" && eventTypes.includes("pull_request")) {
      branchName = event.pull_request?.head?.ref || "unknown";
      payload = buildPullRequestPayload(event, branchFilter, options);
    } else if (eventName === "release" && eventTypes.includes("release")) {
      branchName = getBranchName(event.release?.target_commitish || "main");
      payload = buildReleasePayload(event, branchFilter, options);
    } else {
      core.info(`Ignoring unsupported or disabled event: ${eventName}`);
      core.setOutput("status", "ignored");
      core.setOutput("event_type", eventName);
      core.setOutput("repository", repoFullName);
      core.setOutput("branch", branchName);
      core.setOutput("commit_count", "0");
      core.setOutput("sent", "false");
      return;
    }

    if (!payload) {
      core.info(`Skipping ${eventName} because it did not match branch filters.`);
      core.setOutput("status", "skipped");
      core.setOutput("event_type", finalEventType);
      core.setOutput("repository", repoFullName);
      core.setOutput("branch", branchName);
      core.setOutput("commit_count", "0");
      core.setOutput("sent", "false");
      return;
    }

    core.info(`Sending Discord webhook for ${eventName} in ${repoFullName}`);
    await sendDiscordWebhook(webhookUrl, payload, retryCount, retryBackoffMs);

    const commitCount = eventName === "push" ? (event.commits || []).length : 1;

    core.setOutput("status", "success");
    core.setOutput("event_type", finalEventType);
    core.setOutput("repository", repoFullName);
    core.setOutput("branch", branchName);
    core.setOutput("commit_count", String(commitCount));
    core.setOutput("sent", "true");
  } catch (error) {
    core.error(`Discord notifier failed: ${error.message}`);
    core.setOutput("status", "failure");
    core.setOutput("event_type", process.env.GITHUB_EVENT_NAME || "unknown");
    core.setOutput("repository", "unknown");
    core.setOutput("branch", "unknown");
    core.setOutput("commit_count", "0");
    core.setOutput("sent", "false");

    if (failOnWebhookError) {
      core.setFailed(error.message);
    }
  }
}

run();
