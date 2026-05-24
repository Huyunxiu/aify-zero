import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useTranslation } from "react-i18next";

import { orpc } from "@/utils/orpc";

const Second = () => {
  const { t } = useTranslation();
  const healthCheck = useQuery(orpc.healthCheck.queryOptions({ staleTime: 0 }));

  return (
    <div className="w-dvh max-w-full mx-auto text-center min-h-svh flex flex-col box-border">
      <section
        id="center"
        className="flex grow flex-col place-content-center place-items-center gap-4"
      >
        <div className="flex flex-col gap-4">
          <p>
            {t("apiStatus")}:{" "}
            <code className="text-base px-2 py-1 bg-muted rounded">
              {healthCheck.data}
            </code>
          </p>
          <p>
            {t("edit")}{" "}
            <code className="text-base px-2 py-1 bg-muted rounded">
              src/routes/second.tsx
            </code>{" "}
            {t("andSaveToTest")}{" "}
            <code className="text-base px-2 py-1 bg-muted rounded">
              {t("hmr")}
            </code>
          </p>
        </div>
        <Button className="mt-2" nativeButton={false} render={<Link to="/" />}>
          {t("goToHomePage")}
        </Button>
        <div className="text-muted-foreground text-sm">
          ({t("press")} <kbd>d</kbd> {t("toToggleDarkMode")})
        </div>
        <div className="text-muted-foreground text-sm">
          ({t("press")} <kbd>l</kbd> {t("toToggleLangMode")})
        </div>
      </section>
    </div>
  );
};

export const Route = createFileRoute("/second")({
  component: Second,
});
