# 上传说明（给 Codex）

这是“初司运营账号数据面板”的源码，请上传到 GitHub **私有**仓库（建议名：chusi-dashboard）。

- 压缩包里只有源码、测试和说明，共 37 个文件，外加本说明。不含 `data/`（各账号浏览器登录状态、访问口令、数据库）和 `backups/`，这两个目录绝对不要上传。
- 根目录的 `.gitignore` 已经排除 data/、backups/、*.db、*.log、access-token 等文件，请保留。
- 许可：参考的上游项目 MIT 许可证保留在 `third-party/maitian-MIT-LICENSE`，请一并上传。
- 仓库必须设为 Private。
- 运行需要 macOS、Node 24、Google Chrome；运行方法和各平台数据口径见 README.md。
- 测试：`node --test`（179 项）。
