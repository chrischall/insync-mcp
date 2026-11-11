# Changelog

## [0.5.0](https://github.com/chrischall/insync-mcp/compare/v0.4.0...v0.5.0) (2026-11-11)


### Features

* **messages:** read message bodies as Markdown, keeping lines, lists and links ([#25](https://github.com/chrischall/insync-mcp/issues/25)) ([4a848a0](https://github.com/chrischall/insync-mcp/commit/4a848a04682cca76b57fc1e3950201fdce4bbf7d))

## [0.4.0](https://github.com/chrischall/insync-mcp/compare/v0.3.0...v0.4.0) (2026-11-07)


### Features

* **files:** upload insurance cards and download files from hosted sessions ([#21](https://github.com/chrischall/insync-mcp/issues/21)) ([6de538b](https://github.com/chrischall/insync-mcp/commit/6de538b91e48e4c5c2c9e67c9918e9c6cad64871))


### Bug Fixes

* **deps:** bump node-html-parser ([#19](https://github.com/chrischall/insync-mcp/issues/19)) ([324aff2](https://github.com/chrischall/insync-mcp/commit/324aff2a728ddfc9ca2bbe90a2000d64470458f1))
* **deps:** upgrade @chrischall/mcp-utils to 3.7.2 so uploads carry only the file's bytes ([#24](https://github.com/chrischall/insync-mcp/issues/24)) ([5cb5d61](https://github.com/chrischall/insync-mcp/commit/5cb5d61ab23104b6e49c4869d18eb6df0ba723f6))


### Documentation

* **downloads:** note the download output change for upgraders ([#23](https://github.com/chrischall/insync-mcp/issues/23)) ([530d5b0](https://github.com/chrischall/insync-mcp/commit/530d5b052ee4c26dc5865da1ff250ed24434de0f))

## [0.3.0](https://github.com/chrischall/insync-mcp/compare/v0.2.2...v0.3.0) (2026-11-04)


### Features

* context-group hints ([#13](https://github.com/chrischall/insync-mcp/issues/13)) ([a898d79](https://github.com/chrischall/insync-mcp/commit/a898d79fd3c6a4b4808701ad2b59e22586d2beea))


### Bug Fixes

* **brief:** align the brief view with the fleet contract ([#17](https://github.com/chrischall/insync-mcp/issues/17)) ([fcf42e7](https://github.com/chrischall/insync-mcp/commit/fcf42e7838018b9c1fcb6371fd5822fe5bd210c4))

## [0.2.2](https://github.com/chrischall/insync-mcp/compare/v0.2.1...v0.2.2) (2026-10-29)


### Bug Fixes

* **deps:** require the MCP SDK ^2.4.0 that mcp-utils 3.4.0 peer-requires ([#11](https://github.com/chrischall/insync-mcp/issues/11)) ([c6fe73d](https://github.com/chrischall/insync-mcp/commit/c6fe73d50dfb08f6afb3597287e6894bc9f59a8b))

## [0.2.1](https://github.com/chrischall/insync-mcp/compare/v0.2.0...v0.2.1) (2026-10-29)


### Bug Fixes

* **deps:** require mcp-utils 3.4.0 and use its shared stripUrlishKeys ([#9](https://github.com/chrischall/insync-mcp/issues/9)) ([4c4ecc5](https://github.com/chrischall/insync-mcp/commit/4c4ecc5f351350a86ef48d8310e70cd088918001))

## [0.2.0](https://github.com/chrischall/insync-mcp/compare/v0.1.0...v0.2.0) (2026-10-29)


### Features

* confirm-gated messages, refill, appointment and cancellation requests ([#2](https://github.com/chrischall/insync-mcp/issues/2)) ([4487db2](https://github.com/chrischall/insync-mcp/commit/4487db252609c81d3f8f75b99332d4b97c780113))


### Bug Fixes

* **security:** fail closed in stripUrlishKeys and origin-check the first login handoff hop ([#6](https://github.com/chrischall/insync-mcp/issues/6)) ([8c41b87](https://github.com/chrischall/insync-mcp/commit/8c41b87dbc6bbdf037200b96e64c1b451810d6d5)), closes [#5](https://github.com/chrischall/insync-mcp/issues/5)
* **security:** pin session cookies to the portal host and harden write, download and unread-gate paths ([#4](https://github.com/chrischall/insync-mcp/issues/4)) ([0a93700](https://github.com/chrischall/insync-mcp/commit/0a93700e973e6d8bcfc0552b54fa3fe4161d48a7))


### Refactor

* **transport:** adopt mcp-utils CookieJar and one shared per-hop origin check ([#7](https://github.com/chrischall/insync-mcp/issues/7)) ([756c126](https://github.com/chrischall/insync-mcp/commit/756c1260a8989c1dcb10029504b093d42857fa04))

## 0.1.0 (2026-10-28)


### Features

* file downloads via portal endpoints ([6960451](https://github.com/chrischall/insync-mcp/commit/6960451592cbbce89af6696e3ea8235462689108))
* insurance-card upload (confirm-gated) ([374e8ee](https://github.com/chrischall/insync-mcp/commit/374e8eecd315f11248c0dcc06e20684cb9769f4c))
* packaging, mint.yaml, docs ([762b933](https://github.com/chrischall/insync-mcp/commit/762b933f36d800d36a2a04ae82e2fd61c6ae46b6))
* read tools ([d0cbc1f](https://github.com/chrischall/insync-mcp/commit/d0cbc1f5c6ac3da2cb81e235395017b0b01a9f04))
* transports and client ([e08c88e](https://github.com/chrischall/insync-mcp/commit/e08c88ead6120c6ad15fc82fd9b32c4f7bc96fbb))


### Documentation

* generalize storage-config wording ahead of public release ([bcbf792](https://github.com/chrischall/insync-mcp/commit/bcbf792072891ec8a48c07d919a372189ad89efd))
