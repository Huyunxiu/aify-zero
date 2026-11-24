/**
 * Where a Bot's avatar file name is recorded.
 *
 * The image belongs to the asset layer (`<botHome>/assets/avatar.<ext>`); the database
 * only remembers which file is current. This is the single writer, so a client cannot
 * point the column anywhere.
 */
import { updateBotRow } from "./bot.repository";

/**
 * Record the file name the asset directory actually wrote; `null` means the avatar is
 * gone.
 *
 * @param botId - The sentinel id or the uuid of a Bot.
 * @param fileName - Such as `avatar.webp`.
 */
export async function recordBotAvatarPath(
  botId: string,
  fileName: string | null
): Promise<void> {
  await updateBotRow(botId, { avatarPath: fileName });
}
