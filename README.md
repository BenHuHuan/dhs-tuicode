# dhs-tui

English | [中文](README.zh.md)

`dhs-tui` is a personal fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), maintained by [BenHuHuan](https://github.com/BenHuHuan).

It keeps the original architecture where **everything is a plugin**, powered by [Cordis](https://github.com/cordiverse/cordis), and adds a local TUI experience on top.

## Developer preview

This project is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run from source

```sh
git clone https://github.com/BenHuHuan/dhs-tui.git
cd dhs-tui
pnpm install
pnpm run build
pnpm dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Issues](https://github.com/BenHuHuan/dhs-tui/issues).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
