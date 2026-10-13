# RWAIX 参考实现

[![acceptance](https://github.com/hw7325391218-create/rwaix/actions/workflows/acceptance.yml/badge.svg)](https://github.com/hw7325391218-create/rwaix/actions/workflows/acceptance.yml)

这是 RWAIX 信任与交易提案（2026-10-12 白皮书，取代 v6.4）的纸面测试系统。协议版本 `rwaix-0.1.0`，模式发布 `1.1.0`，实现版本 `0.5.1`。

规范文本是 `docs/spec/whitepaper-2026-10-12-zh.txt`。它取代 `docs/spec/whitepaper-v6.4-zh.txt`。v6.4 英文文件仍是上一版译文，不是 2026-10-12 文本的翻译。对照见 `docs/spec/CHANGELOG-v6.4-to-2026-10-12.md`。模式字节仍是发布 `1.1.0`，没有改动。

本仓库是参考实现。它不是标准组织的规范文本，不是认证结果，也不是生产系统。`RWAIX_TEST` 与 `DCNFT-TEST` 只是本地占位。它们不是证券发行，也不是已上线的网络通证。本地 `Deploy.s.sol` 仍拒绝链 id `1`。另一条发行部署可以在显式选择 Sepolia 或主网后部署空的 `$RWAIX` 与 `DCNFT` 外壳。主网还需要 `RWAIX_MAINNET_OPT_IN=1` 和手动输入 `MAINNET`。该部署不铸造。发行保持关闭，直到法律与合规签署。George 自己执行的步骤在 `INSTALL.md`。

English: [README.md](README.md).

## 目录

| 路径 | 作用 |
| --- | --- |
| `packages/schemas/v1` | 冻结的 JSON Schema（`additionalProperties: false`）以及 `freeze.json` 摘要 |
| `packages/protocol` | 规范 JSON、JWS（ES256）、EIP-712、模式校验、错误码 |
| `packages/policy-engine` | 封闭谓词引擎，不执行任意代码 |
| `packages/verifier` | 签发并复核 TrustReceipt，回执固定 `policyDigest` |
| `packages/economics` | 内存中的权利账本与网络账本（费用、保证金、奖励、供应） |
| `packages/sdk` | `ReferenceService`：九个接口，外加 `trade` 与 `setStatus` |
| `packages/adapter-sdk` | 行业适配器接口 |
| `packages/adapter-compute` | 算力适配器，剖面 `compute.delivery` 1.0.0。白皮书 v6.4 第 18.6 节的后续扩展 |
| `packages/adapter-profiles` | NFT 交易剖面 `nft.trade` 1.0.0，以及第 18 节其余剖面 |
| `packages/persistence` | Postgres 或内嵌 PGlite 日志 |
| `packages/indexer` | 区块哈希快照、终局与重组 |
| `packages/status-list` | W3C Bitstring Status List |
| `packages/disclosure` | 基于 JWS ES256 的 SD-JWT 选择性披露 |
| `packages/zk` | Groth16 范围证明（公开测试仪式） |
| `packages/identity` | `did:key` / `did:web`、VC、账户恢复 |
| `packages/agent` | 受限 Agent 预算 |
| `packages/scenarios` | 八个演示。NFT 交易排在首位。第 19 节链路仍是后续扩展 |
| `packages/server` | 纸面界面与 HTTP API |
| `packages/conformance` | 向量运行器，写出 `ConformanceManifest` |
| `verifiers/python` | 共享向量上的第二套内核核验器 |
| `contracts` | Foundry 合约、本地测试桥、本地 4337 账户 |
| `scripts/demo-flow.ts` | 第 26 节 NFT 走查 |
| `docs/spec` | 2026-10-12 中文白皮书、它所取代的 v6.4 文本，以及变更说明 |
| `deploy/docker-compose.yml` | Postgres、两条 Anvil、部署、API、界面 |
| `docs/operations.md` | 安装、健康检查、备份、索引器与桥的边界 |
| `docs/signing-domain.md` | 签名、规范化、nonce、时间 |
| `docs/recovery-runbook.md` | 暂停、重组、未知支付、密钥失陷 |

三本账分开，只通过业务标识相连（`tradeId`、`obligationId`、`seriesId`、`objectId`）：

1. 对象与证据（`ReferenceService`）。
2. 权利绑定（仅测试；`securitiesIssuance` 为 false）。
3. 网络经济（报价、费用、保证金、奖励、供应）。

## 模块状态

| 模块 | 状态 |
| --- | --- |
| 模式包、签名域、策略引擎、核验器、九个接口 | 已实现，有测试 |
| 七个后续剖面与第 19 节链路 | 已在进程内实现。算力是扩展，不是首个应用 |
| NFT 交易剖面（`nft.trade`） | 合成订单、许可条款、完整 portion 验收、单独付款，以及一笔保持打开的争议。不是公司平台接入，也不描述公司全部 NFT 产品 |
| Postgres / PGlite 日志与链索引器 | 已实现。不是生产高可用数据库 |
| W3C Bitstring Status List | 已实现 16KB 列表、比特顺序，以及不可逆撤销 |
| SD-JWT 选择性披露 | 已实现，沿用现有 JWS。没有实现 BBS+ |
| 接入证据与回执检查的 Groth16 范围证明 | 已实现。仪式的可靠性仍为未评测 |
| DID（`did:key`、`did:web`）与 JWS 可验证凭证 | 已实现。不是完整的 JSON-LD VC 数据模型 |
| 账户恢复（门槛、延迟、冻结） | 已实现。恢复不移动资产，也不恢复已撤销凭证 |
| 受限 Agent 预算 | 已实现。子授权只能收窄 |
| 本地 ERC-4337 形态账户 | 本地入口点的 Forge 测试。不是规范捆绑器，HTTP 执行器也不调用它 |
| 本地双链锁定/铸造 | Forge 测试加上 compose 部署。不是生产桥，也不是轻客户端 |
| Python 内核核验器 | 通过共享的规范化、策略、SD-JWT 与状态向量。它不运行 Groth16 |
| 托管、真实支付通道、ERC-5484 认证 | 未评测 |
| 主网部署与标准认证 | 未评测；代码能拒绝的路径会拒绝 |

`pnpm conformance` 打印 `ConformanceManifest`。通过只覆盖本进程实际跑过的 MUST 向量。标成 `未评测` 的模块不在该声明内。MUST 失败不能被豁免成通过。

## 接口

`ReferenceService` 提供：

`registerObject`、`publishVersion`、`resolveBinding`、`submitEvidence`、`evaluatePolicy`、`verifyReceipt`、`checkStatus`、`prepareIntent`、`executeIntent`。

`trade` 与 `setStatus` 是参考辅助接口。它们同样是已签名动作，不是未签名旁路。请求模式为 `rwaix.signed.v1`。同一幂等键配上不同载荷摘要返回 `IDEMPOTENCY_CONFLICT`。同一已签名正文的重试返回已存储结果。nonce 在幂等检查之后才消耗。

策略结论为 `ALLOW`、`DENY` 或 `INDETERMINATE`。证据缺失是 `INDETERMINATE`，不是 `ALLOW`。环是 `DENY`。深度、节点、边和超时预算失败即关闭，不签发 ALLOW 回执。未知的必填字段被拒绝。已登记的可选扩展予以保留。

## 运行测试

需要 Node.js 22 与 pnpm 10.33.3（见根目录 `package.json` 的 `packageManager`）。只有合约任务需要 Foundry。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm conformance
pnpm acceptance
pnpm demo
```

## 验收套件

`pnpm acceptance` 运行 [`docs/acceptance/ACCEPTANCE-50.md`](docs/acceptance/ACCEPTANCE-50.md) 里的 50 项。它写出 `packages/acceptance/out/acceptance-report.json` 和 `packages/acceptance/out/acceptance-report.md`。标题行是这次进程的真实计数，例如在安装了 Chrome 的 GitHub Actions 中为 `48/50 passed (0 failed, 2 not evaluated)`。在没有 Chrome 的机器上，浏览器布局项也为 `NOT_EVALUATED`，结果为 `47/50 passed (0 failed, 3 not evaluated)`。`NOT_EVALUATED` 表示该环境没有满足这项条件。这条命令不重用、也不声称 2026-10-12 已归档的 50/50 记录。

链 id 与发行外壳两项需要 Foundry，并先按下面的合约命令安装 `forge-std`。浏览器布局项需要 Chrome。`puppeteer-core` 随工作区安装。没有 Chrome 时该项为 `NOT_EVALUATED`。GitHub Actions 的验收任务会安装 Chrome，因此该项会在 CI 中执行。两个独立团队交换证据包（A21），以及第 22 节的性能与采用研究（A50），仍为 `NOT_EVALUATED`。

## W3C VC 互操作与测试密钥声明

`pnpm vc-interop` 用固定提交的 W3C VC 测试套件测试本地 VC-API：118/87/102 通过，0 失败。详见 [`docs/interop/README.md`](docs/interop/README.md)。

> **警告：** VC-API 的签发密钥（包括公开端点 `https://www.rwaix.io/vc-api/`）是由源码中固定种子派生的公开测试密钥。其签名不代表任何身份信任。可设置 `RWAIX_VC_EDDSA_SEED_HEX` 和 `RWAIX_VC_ECDSA_KEY_HEX` 使用自己的密钥。

GitHub Actions 在 push 和 pull request 上运行 `pnpm acceptance`，并把 JSON 与 Markdown 报告上传为 `acceptance-report` 产物。上面的徽章指向该工作流。

合约（Foundry 1.x，Solidity 0.8.26）。`contracts/lib` 不入库：

```bash
forge install foundry-rs/forge-std@v1.17.0
forge test --root contracts
```

`forge install` 需要 git 仓库。不要再传 `--no-commit`，当前 Foundry 镜像已去掉该参数。本仓库已是 git 仓库。单独拷出的 `contracts/` 目录要先 `git init`。不加 `--commit` 时安装不会提交。

`PATH` 上有 `forge` 时，`pnpm conformance` 会跑 `forge test`，并把 `solidity-dual-token` 记为 pass 或 fail。没有 `forge` 时该模块为 `未评测`，链下 MUST 向量仍可通过。合约是否通过以合约任务为准。

模式字节冻结在 `packages/schemas/v1/freeze.json`。有意修改模式后运行 `pnpm freeze` 并提交新摘要。语义变化需要新的模式 id。

## 演示流程

`pnpm demo` 走一遍合成的 NFT 交易，对应 2026-10-12 白皮书第 17 节的首个计划应用。不连接链，不铸造真实 NFT，也不移动真实资金。不可分割对象和零网络费是演示参数。算力交付仍可作为场景运行，但不是这条默认路径。验收后付款是本演示选定的顺序。

1. 绑定。登记一件普通作品对象（`ASSET`、`TRANSFERABLE`）并发布版本 1。调用方可以既不持有 DCNFT，也不持有 `RWAIX_TEST`。
2. 承诺。买方与卖方签署同一 `termsDigest`。价款为 `12000` `USD_TEST`（精度 2）。网络费为 `0` `RWAIX_TEST`。许可字段留在交易条款里。设施权益账保持为空。
3. 交付。卖方记录这一枚不可分割 NFT 的数量 1。TrustReceipt 不能代替验收。
4. 核验。范围内证据可以是 `ALLOW`，并固定 `policyDigest`。把 `copyrightTransfer` 改成 `true` 得到 `DENY`（`DOMAIN_POLICY_SCOPE_MISMATCH`）。
5. 验收。一个 portion。再次验收同一 portion 返回 `PORTION_DUPLICATE`，数量不增加。
6. 授权。资金角色授权应付。回执不是该授权。
7. 提交。`INCLUDED` 返回 `FINALITY_NOT_REACHED`。`FINAL` 才执行 `12000`。
8. 对账。资金归属与执行确认分开记录。
9. 冲销。清偿结清价款并保留执行记录。金额为零的网络费义务仍然分开。
10. 争议。交付争议保持 `OPEN`。沉默不退款、不重铸、不冲正已清偿记录。

## 纸面界面与本地链

`pnpm start` 在 `http://127.0.0.1:8787` 提供浏览器演示。页面默认打开 NFT 交易，并可以运行全部八个场景。每个场景展示承诺、证据核验、独立验收，以及价款与网络费的分账，同时披露实现范围、本次记录的步骤和未完成的生产条件。没有真实资金移动，也不铸造真实 NFT。默认存储是内嵌 PGlite。NFT 场景里的卖方控制、接收方和链字段都是合成声明。它们不是链上确认、版权核查或平台授权。第 21 节的下一阶段工程不在本声明内。

```bash
pnpm start
docker compose -f deploy/docker-compose.yml up -d --build
deploy/install-ubuntu.sh
deploy/install-ubuntu.sh --https-port 8443
```

Compose 只把 Postgres、Anvil `31337`、Anvil `31338` 和 API 发布到 `127.0.0.1`。`Deploy.s.sol` 接受这两条链 id，其余回退。发行外壳使用 `contracts/script/deploy-issuance.sh`，不使用原始私钥。测试不需要 Docker；Foundry 使用自带 EVM。备份、健康检查和主网步骤见 `docs/operations.md` 与 `INSTALL.md`。

## 许可

Apache-2.0。见 [LICENSE](LICENSE)。发布本参考实现不授予白皮书或任何通证上的权利，也不是认证。安全问题见 [SECURITY.md](SECURITY.md)。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
