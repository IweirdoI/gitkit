# 平台适配范围 · Platform coverage

Git 的提交对象、分支、fetch 和 push 协议可跨平台复用。只要服务端支持所用 Git 能力、地址和凭据配置正确，原生 Git 操作通常可工作。
这属于协议兼容范围，尚不能视为每个平台都经过端到端验收。

GitHub.com 与 Gitee.com 已有 PR 和 Issue API 适配器。GitHub Issue 生命周期做过真实 API 冒烟，Gitee 依照其 API 路由做自动化模拟验证。
自建 GitHub/Gitee 域名尚未配置，不能直接套用托管域名的认证地址。

- GitLab 可扩展。它使用项目 ID/编码路径、Merge Request 和项目级 Issue iid，需要新的 API 路由、令牌及分页适配。[Issues API](https://docs.gitlab.com/api/issues/)
- Gitea/Forgejo 可扩展。其模型接近 GitHub，但 API 基址、版本与自建站点配置仍需单独核验。[Gitea API](https://docs.gitea.com/development/api-usage/)
- Azure DevOps 可扩展。PR 属于 Git Repositories，问题通常是 Azure Boards Work Items，创建使用 JSON Patch，需要独立模型映射。[Git PR API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1) · [REST overview](https://learn.microsoft.com/en-us/azure/devops/integrate/how-to/call-rest-api?view=azure-devops)
- Bitbucket 可扩展 PR，Cloud 与 Data Center 需分开。Cloud 原生 Issue/Wiki API 已移除，不能把 GitHub Issue 操作直接映射过去，需结合实际的任务系统。[官方变更记录](https://developer.atlassian.com/cloud/bitbucket/changelog/)

本轮只调研上述平台，未添加相应适配器。

## English

Git objects, branches and the fetch/push protocols are shared across providers. Native Git commands can work when the server supports the requested capability and credentials are configured. This is protocol compatibility, with no end-to-end certification for every provider.

GitHub.com and Gitee.com have PR and Issue adapters. GitHub Issue lifecycle operations received a live API smoke test; Gitee is covered by API simulation tests. Self-hosted base URLs need explicit future support.
GitLab needs project identity, MR and issue-iid mappings; Gitea/Forgejo need base-URL and version handling; Azure DevOps needs Git PR and Work Item adapters. Bitbucket Cloud and Data Center differ, and Cloud has removed its native Issue API as documented above.
These additional integrations are research only in this change.
