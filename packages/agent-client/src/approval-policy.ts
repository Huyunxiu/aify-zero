/**
 * 一个会话的询问姿态。
 *
 * 客户端选、服务端存、agent 解释：值域归三方共用，所以放在协议包里。它只
 * 决定「问不问」；能不能做仍由沙箱决定。
 */
export type ApprovalPolicy = "standard" | "edit" | "readonly" | "unrestricted";

/** 没人选过时用它：和引入策略之前的行为一致。界面、库、判定都认这一个值。 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "standard";

/** 从严到从宽。界面按这个顺序列，最不容易出事的一档在最上面。 */
export const APPROVAL_POLICIES = [
  "readonly",
  "standard",
  "edit",
  "unrestricted",
] as const satisfies readonly ApprovalPolicy[];
