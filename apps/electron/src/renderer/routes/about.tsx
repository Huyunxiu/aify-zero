import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@workspace/ui/components/button";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

function AboutPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-screen flex-col items-center justify-center">
      <h1>{t("welcome")}</h1>
      <div className="mt-6 flex flex-col items-center justify-center">
        <p>System health: ok</p>
        <Button className="mt-4" render={<Link to="/" />}>
          Hello AboutPage!
        </Button>
      </div>
    </div>
  );
}
