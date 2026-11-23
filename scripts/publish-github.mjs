#!/usr/bin/env node
// 创建 GitHub 远程仓库并推送。
//
// 前置：gh 已登录（gh auth status 能看到账号）。
// 用法：node scripts/publish-github.mjs [--private]
//
// 一条命令完成：建仓库 → 设 remote → 推 main。
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_NAME = process.argv.includes("--name")
  ? process.argv[process.argv.indexOf("--name") + 1]
  : "code-team";
const PRIVATE = process.argv.includes("--private");

function gh(args, opts = {}) {
  const res = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: true,
  });
  return { code: res.status ?? 1, out: (res.stdout || "") + (res.stderr || "") };
}

// 1. 检查登录
const auth = gh(["auth", "status"], { quiet: true });
if (auth.code !== 0) {
  console.error("gh 未登录。请先在终端执行：");
  console.error("");
  console.error("  gh auth login --hostname github.com --git-protocol https --web");
  console.error("");
  console.error("（浏览器里点一次授权即可，token 会存进系统凭据管理器）");
  process.exit(1);
}
console.log("已登录 gh，继续");

// 2. 远程仓库是否已存在
const exists = gh(["repo", "view", REPO_NAME, "--json", "name"], { quiet: true });
if (exists.code !== 0) {
  console.log("创建远程仓库 " + REPO_NAME + (PRIVATE ? "（私有）" : "（公开）"));
  const created = gh([
    "repo", "create", REPO_NAME,
    PRIVATE ? "--private" : "--public",
    "--source", ".",
    "--remote", "origin",
    "--push",
    "--description", "多 Agent 协作工作流：决策权在 Overmind，不在主会话",
  ]);
  if (created.code !== 0) process.exit(created.code);
  console.log("已创建并推送");
} else {
  console.log("远程仓库已存在，只推送");
  const remote = gh(["repo", "view", REPO_NAME, "--json", "sshUrl", "-q", ".sshUrl"], { quiet: true });
  const urlMatch = remote.out.match(/"sshUrl":"([^"]+)"/);
  const url = urlMatch ? urlMatch[1] : `https://github.com/${REPO_NAME}.git`;
  const setRemote = spawnSync("git", ["remote", "remove", "origin"], { cwd: ROOT, stdio: "ignore", shell: true });
  spawnSync("git", ["remote", "add", "origin", url], { cwd: ROOT, stdio: "inherit", shell: true });
  const pushed = gh(["repo", "sync", "--branch", "main"], { quiet: true });
  const push = spawnSync("git", "push -u origin main", { cwd: ROOT, stdio: "inherit", shell: true });
  process.exit(push.status ?? 1);
}

console.log("");
console.log("完成：https://github.com/" + REPO_NAME);
