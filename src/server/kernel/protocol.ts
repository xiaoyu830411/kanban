/**
 * 协议错误：内核公共契约的一部分（ADR-0001 的「协议在 API 层强制执行」）。
 * code 机器可读，Agent 侧（T7/T12）依赖它做协议级处理。
 */
export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
