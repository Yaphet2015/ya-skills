# PBench

pbench 把 Codex 或 Claude 的真实失败保存为私有 Harbor case。任务和产物留在本机。模型请求发给所选服务。运行需要 `uv`、Python 3.12（必要时由 uv 安装）、Docker 和 Docker Compose。pbench 使用 Harbor 0.25.0。

## 保存和运行

```sh
yk pbench capture --source codex --session-id SESSION --yes
yk pbench validate --case CASE --fail run:KNOWN_FAILURE --pass run:KNOWN_SUCCESS
yk pbench run --case CASE --agent codex --model openai/MODEL --attempts 5 --profile baseline
yk pbench report --case CASE --format json
```

`capture` 保存原始请求、Git 基线和私有会话证据。可以用 `--task DIR` 提供已有的 Harbor 模板，将 `environment/source` 留给捕获的 Git 基线。也可以编辑生成的 `harbor/` 目录。在 `task.toml` 声明产物，并写好 `tests/test.sh`。独立的 `tests/Dockerfile` 需要把脚本放到 `/tests/test.sh`。脚本将总分 `reward` 和分项分数写入 `/logs/verifier/reward.json`。

发现未提交改动时，如果确认任务从记录的 commit 开始，可用 `--baseline-only`。需要保留部分改动时，从私有证据里核对后放到 `harbor/environment/source`，把 `case.json` 中的 `replayStart.status` 设为 `curated`。环境和 verifier 齐备时，`capture` 会保存镜像。先留档后补齐的 case 用 `yk pbench finalize --case CASE` 保存镜像。任务或 verifier 有改动时，保存新版后再运行。

报告按任务版本和 profile 比较。用 `--skill DIR` 给某个 profile 保存并加载本地 skill。仓库 rules 和任务 MCP 配置随任务版本一起保存。用 `--env NAME,NAME` 注入当前环境中的指定变量。常用的 Codex 和 Claude 凭证由 runner 按变量名传递。

## 怎么提供正反例

挑你已经知道对错的结果。两例都可直接复用现有记录。`validate --strict` 默认用无操作样本和已有的私有参考解法。用 `--fail` 或 `--pass` 可指定任意一边。

| 样本 | 来源 |
| --- | --- |
| `run:TRIAL_ID` | 同一 case 的 pbench 试跑。从报告复制 trial ID，直接复评保存的产物。 |
| `trial:/path/to/trial` | 有 `result.json` 和所需产物的本地 Harbor trial 目录。 |
| `git:COMMIT` | 将 case 基线到这个 commit 的差异应用到新容器。任务镜像需要 Git，仓库位于 `/app`。 |
| `nop` / `oracle` | 直接评分起始状态，或运行 `solution/solve.sh` 后评分。 |

复评历史产物无需重跑模型。会话记录能帮助编写 verifier。如果会话没有保存最终产物，使用 trial 或 Git commit。反例得到有效的 `0`、正例得到有效的 `1` 后，verifier 标为已验证。缺样本或执行错误时继续留档，可先运行 case 收集产物。

`yk pbench audit` 查看 case 状态。用 `yk pbench export-replay --case CASE --out DIR` 导出任务说明。已有 workspace 链接仍可用。宿主机 worktree 的手动回放已停用。

[Harbor 任务格式](https://docs.harborframework.com/tasks/overview) · [Vercel 文章](https://vercel.com/blog/agent-evals)
