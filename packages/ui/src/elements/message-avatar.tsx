import { createAvatar } from "@oreo-design/avatar";

import Logo from "../assets/logo/icon.svg";
import { Avatar, AvatarFallback, AvatarImage } from "../components/avatar";

// 头像按角色固定，只在模块加载时生成一次：每个 turn 都会渲染一次，
// 跟着渲染重算一遍 SVG 是白费。
const userAvatarSrc = createAvatar({
  shape: "flare",
  palette: "cotton-candy",
  variantId: "user",
}).toDataUri();

/** 用户消息的头像，由消息行摆在内容右侧。 */
export const UserAvatar = () => (
  <Avatar className="mt-0.5" size="sm">
    <AvatarImage alt="User" src={userAvatarSrc} />
    <AvatarFallback>U</AvatarFallback>
  </Avatar>
);

/** 助手消息的头像，由消息行摆在内容左侧。 */
export const AssistantAvatar = () => (
  <Avatar className="mt-0.5" size="sm">
    <AvatarImage alt="Assistant" src={Logo} />
    <AvatarFallback>A</AvatarFallback>
  </Avatar>
);
