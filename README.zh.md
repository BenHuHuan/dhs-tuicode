# dhs-tui

[English](README.md) | 中文

`dhs-tui` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 fork，由 [BenHuHuan](https://github.com/BenHuHuan) 维护。

它保留了原项目**一切皆插件**的架构，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，并在此基础上提供本地 TUI 体验。

## 开发者预览

本项目目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 从源码运行

```sh
git clone https://github.com/BenHuHuan/dhs-tui.git
cd dhs-tui
pnpm install
pnpm run build
pnpm dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。

## 社区与支持

- 欢迎通过 [GitHub Issues](https://github.com/BenHuHuan/dhs-tui/issues) 提交反馈或 bug 报告。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
