import { ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { deleteBot } from "./bot.delete";
import {
  botIdInputSchema,
  createBotInputSchema,
  deleteBotInputSchema,
  testBotMcpInputSchema,
  updateBotInputSchema,
} from "./bot.schema";
import {
  createBot,
  getBot,
  getBotMcpStatuses,
  listBots,
  listBotSkills,
  testBotMcp,
  updateBot,
} from "./bot.service";

const list = publicProcedure
  .route({ method: "GET", path: "/bots" })
  .handler(async () => ({ bots: await listBots() }));

const get = publicProcedure
  .route({ method: "GET", path: "/bots/{botId}" })
  .errors({ BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND })
  .input(botIdInputSchema)
  .handler(async ({ input }) => ({ bot: await getBot(input.botId) }));

const create = publicProcedure
  .route({ method: "POST", path: "/bots" })
  .errors({
    PROJECT_NOT_FOUND: ErrorMap.PROJECT_NOT_FOUND,
    MCP_SERVER_DUPLICATE: ErrorMap.MCP_SERVER_DUPLICATE,
  })
  .input(createBotInputSchema)
  .handler(async ({ input }) => ({ bot: await createBot(input) }));

const update = publicProcedure
  .route({ method: "PUT", path: "/bots/{botId}" })
  .errors({
    BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND,
    PROJECT_NOT_FOUND: ErrorMap.PROJECT_NOT_FOUND,
    MCP_SERVER_DUPLICATE: ErrorMap.MCP_SERVER_DUPLICATE,
  })
  .input(updateBotInputSchema)
  .handler(async ({ input }) => ({ bot: await updateBot(input) }));

const remove = publicProcedure
  .route({ method: "DELETE", path: "/bots/{botId}" })
  .errors({
    BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND,
    BOT_BUSY: ErrorMap.BOT_BUSY,
    CANNOT_DELETE_DEFAULT_BOT: ErrorMap.CANNOT_DELETE_DEFAULT_BOT,
  })
  .input(deleteBotInputSchema)
  .handler(async ({ input }) => await deleteBot(input));

const listSkills = publicProcedure
  .route({ method: "GET", path: "/bots/{botId}/skills" })
  .errors({ BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND })
  .input(botIdInputSchema)
  .handler(async ({ input }) => await listBotSkills(input.botId));

const mcpStatuses = publicProcedure
  .route({ method: "GET", path: "/bots/{botId}/mcp/status" })
  .errors({ BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND })
  .input(botIdInputSchema)
  .handler(async ({ input }) => await getBotMcpStatuses(input.botId));

const testMcp = publicProcedure
  .route({ method: "POST", path: "/bots/{botId}/mcp/test" })
  .errors({ BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND })
  .input(testBotMcpInputSchema)
  .handler(async ({ input }) => await testBotMcp(input.botId, input.server));

export const bot = {
  list,
  get,
  create,
  update,
  delete: remove,
  listSkills,
  mcpStatuses,
  testMcp,
};
