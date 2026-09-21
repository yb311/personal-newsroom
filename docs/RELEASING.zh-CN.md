# 所闻发布说明

发布由两个 GitHub Actions 工作流负责：

- `CI`：每次提交到 `main` 或创建 Pull Request 时运行。只测试和生成未签名目录包，不读取发布凭据。
- `Release macOS`：只在推送 `vX.Y.Z` 标签时运行。测试通过后签名、公证、验签并创建 GitHub Release。

## 一次性配置 GitHub Secrets

进入仓库的 **Settings → Secrets and variables → Actions → New repository secret**，添加下面四项：

| Secret 名称 | 内容 |
|---|---|
| `CSC_LINK` | Developer ID Application 证书导出的 `.p12` 文件经过 Base64 编码后的内容 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple Developer 账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 在 Apple 账户页面生成的 App 专用密码，不是 Apple ID 登录密码 |

`APPLE_TEAM_ID` 已固定为公开的团队编号 `PR3596G4YB`，不需要保存为 Secret。GitHub 自带的
`GITHUB_TOKEN` 用于创建 Release，也不需要手动设置。

### 导出签名证书

1. 打开“钥匙串访问”。
2. 进入“登录 → 我的证书”。
3. 展开 `Developer ID Application: Yue Jing (PR3596G4YB)`，确认下面有私钥。
4. 同时选中证书和私钥，导出为 `.p12`，并设置一个临时的高强度密码。
5. 在终端执行下面的命令，把 Base64 内容放入剪贴板：

   ```bash
   base64 -i "/完整路径/Developer ID Application.p12" | pbcopy
   ```

6. 将剪贴板内容粘贴到 `CSC_LINK`，把导出密码保存到 `CSC_KEY_PASSWORD`。
7. Secrets 保存成功后删除本机导出的 `.p12` 文件；仓库已忽略所有 `.p12` 和 `.p8` 文件，避免误提交。

## 发布一个版本

版本号只在准备发布时修改，不随每次提交自动增长。以 `0.1.1` 为例：

```bash
npm version 0.1.1 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

标签必须与 `package.json` 的版本完全一致，否则发布任务会主动停止。成功后，GitHub Release 包含：

- `所闻-X.Y.Z-arm64.dmg`
- `所闻-X.Y.Z-arm64.zip`
- `SHA256SUMS.txt`

发布任务还会检查主应用、Electron 辅助进程、`pnr-reader`、公证票据和 DMG 内最终应用。

## 安全边界

- 发布凭据只用于版本标签任务，普通 Pull Request 无法读取。
- 不使用 `pull_request_target` 执行外部贡献者的代码。
- 不把 `.p12`、`.p8`、密码或 App 专用密码提交到仓库。
- 版本一旦公开，不覆盖同名版本；修复后递增版本号重新发布。
