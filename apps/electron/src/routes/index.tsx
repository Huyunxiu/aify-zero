import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useTranslation } from "react-i18next";

import { orpc } from "@/utils/orpc";

const Home = () => {
  const { t } = useTranslation();
  const healthCheck = useQuery(orpc.healthCheck.queryOptions());

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">{t("welcome")}</h1>
          <p>API Status: {healthCheck.data}</p>
          <Button className="mt-2" render={<Link to="/about" />}>
            Hello HomePage!
          </Button>
        </div>
        <div className="text-muted-foreground font-mono text-xs">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
        <div className="text-muted-foreground font-mono text-xs">
          (Press <kbd>l</kbd> to toggle lang mode)
        </div>
      </div>
    </div>
  );
};

export const Route = createFileRoute("/")({
  component: Home,
});
