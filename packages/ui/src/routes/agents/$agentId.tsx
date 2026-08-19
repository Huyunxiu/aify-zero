import { createAvatar } from "@oreo-design/avatar";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Avatar, AvatarImage } from "@workspace/ui/components/avatar";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { Input } from "@workspace/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item";
import { Switch } from "@workspace/ui/components/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import { Textarea } from "@workspace/ui/components/textarea";
import { Island, IslandGroup } from "@workspace/ui/elements/island";
import { SettingFrame } from "@workspace/ui/elements/settings/setting-frame";
import { TitleBar } from "@workspace/ui/elements/title-bar";

import { client } from "../../lib/orpc";

const AgentPage = () => {
  const { agentId } = Route.useParams();

  const getAgentQuery = useQuery({
    queryKey: ["get_agent"],
    queryFn: () => client.agent.get({ agentId }),
  });

  const listSkillsQuery = useQuery({
    queryKey: ["list_skills"],
    queryFn: () => client.skill.list(),
  });

  const { toDataUri } = createAvatar();

  const avatar = toDataUri();

  return (
    <IslandGroup orientation="horizontal">
      <Island defaultSize="100%">
        <div className="flex h-full w-full flex-row overflow-hidden">
          <div className="flex min-w-0 flex-col w-full">
            {/* session header */}
            <TitleBar className="sticky top-0 flex h-14 items-center gap-2 px-3" />
            {/* session container */}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-4 mx-auto w-2xl">
              <Tabs defaultValue="account" className="w-full">
                <TabsList>
                  <TabsTrigger value="account">通用</TabsTrigger>
                  <TabsTrigger value="password">技能</TabsTrigger>
                </TabsList>
                <TabsContent value="account">
                  <SettingFrame>
                    <ItemGroup>
                      <Item variant="muted">
                        <ItemContent>
                          <ItemTitle className="line-clamp-1">头像</ItemTitle>
                        </ItemContent>
                        <ItemActions className="flex-none text-center">
                          <Avatar>
                            <AvatarImage src={avatar} />
                          </Avatar>
                        </ItemActions>
                      </Item>
                    </ItemGroup>
                    <ItemSeparator />
                    <ItemGroup>
                      <Item variant="muted">
                        <ItemContent>
                          <ItemTitle className="line-clamp-1">名称</ItemTitle>
                        </ItemContent>
                        <ItemActions className="flex-none text-center">
                          <Input placeholder="名称" defaultValue="Untitled" />
                        </ItemActions>
                      </Item>
                    </ItemGroup>
                    <ItemSeparator />
                    <ItemGroup>
                      <Item variant="muted">
                        <ItemContent>
                          <ItemTitle className="line-clamp-1">
                            Description
                          </ItemTitle>
                        </ItemContent>
                        <ItemActions className="flex-none text-center">
                          <Textarea className="w-[180px]" />
                        </ItemActions>
                      </Item>
                    </ItemGroup>
                  </SettingFrame>
                  <div className="mt-6 mb-6 flex">
                    <h1 className="font-bold text-xl">系统提示词</h1>
                  </div>
                  <Textarea className="min-h-60" />
                </TabsContent>
                <TabsContent value="password">
                  <div className="flex gap-6">
                    <Input type="search" placeholder="Search..." />
                    <ButtonGroup>
                      <Button variant="outline">所有</Button>
                      <Button variant="outline">已安装</Button>
                      <Button variant="outline">未安装</Button>
                    </ButtonGroup>
                  </div>
                  <div className="flex flex-col mt-4 gap-2">
                    {listSkillsQuery.data?.data.map((e) => (
                      <Item key={e.location} variant="outline">
                        <ItemContent>
                          <ItemTitle>
                            <span>{e.name}</span>
                            <Badge variant="outline">{e.dir}</Badge>
                          </ItemTitle>
                          <ItemDescription>{e.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Switch />
                        </ItemActions>
                      </Item>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </Island>
    </IslandGroup>
  );
};

export const Route = createFileRoute("/agents/$agentId")({
  component: AgentPage,
});
