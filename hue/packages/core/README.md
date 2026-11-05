# @hue/core（v0.2 参考实现）
类型、事件合同、端口、loop。零 I/O，零运行时依赖。设计说明：docs/packages/core.md

    npx tsc -p .                                   # 类型检查（strict）
    node --import tsx --test test/loop.test.ts     # 11 个合同测试

改接口前先改 docs/packages/core.md；这 11 个测试是所有包并行开发的门槛。
